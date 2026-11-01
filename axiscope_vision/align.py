"""
Closed-loop nozzle auto alignment.

    scan -> probe X / probe Y (learn px<->mm) -> correct -> re-scan
         -> repeat up to max_iterations -> stop and wait for the user

The probe moves measure how the nozzle moves in the image for a known
machine move, giving a 2x2 matrix J (pixels per mm). It absorbs camera
scale, rotation and mirroring, so no camera orientation setup is needed.
Each correction solves J * move = (target - nozzle). After every
correction the observed image motion updates J (Broyden), so a slightly
wrong first estimate still converges.

The aligner never captures or saves anything: it ends in a terminal state
and the UI asks the user to accept, retry or revert.
"""
import json
import math
import os
import threading
import time

import numpy as np

from .detect import detect

ALIGN_DEFAULTS = {
    "max_iterations": 5,      # correction moves after the probe moves
    "tolerance": 0.01,        # mm, radial
    "probe_distance": 0.5,    # mm per probe move
    "max_move": 3.0,          # mm, any single correction larger than this aborts
    "settle": 0.4,            # s to wait after a move before grabbing frames
    "stable_timeout": 4.0,    # s to wait for the image to catch up and hold still
    "samples": 3,             # frames per measurement (median)
    "feed": 10.0,             # mm/s
    "approach": 0.0,          # mm backlash approach (0 disables)
    "reuse_calibration": True,  # use the saved camera mapping instead of probing
}

_LIMITS = {
    "max_iterations": (int, 1, 25),
    "tolerance": (float, 0.001, 0.5),
    "probe_distance": (float, 0.05, 3.0),
    "max_move": (float, 0.1, 20.0),
    "settle": (float, 0.0, 5.0),
    "stable_timeout": (float, 0.0, 20.0),
    "samples": (int, 1, 9),
    "feed": (float, 1.0, 100.0),
    "approach": (float, 0.0, 2.0),
}

MIN_PX_PER_MM = 10.0       # less than this and the camera is not seeing motion
MAX_SKEW_DEG = 30.0        # probe axes must be roughly perpendicular in the image
MAX_SAMPLE_SPREAD = 3.0    # px floor; frames of one measurement must agree
SAMPLE_SPREAD_FRACTION = 0.03  # ...or within 3% of the main ring radius

MAPPING_CHECK_TOLERANCE = 0.35  # saved mapping: max |observed - expected| / |expected|


class MappingStore:
    """Learned camera mappings (px-per-mm matrix) per camera, kept in a JSON
    file so they survive restarts. path=None keeps them in memory only."""

    def __init__(self, path=None):
        self.path = path
        self._lock = threading.Lock()
        self._data = {}
        if path and os.path.exists(path):
            try:
                with open(path) as f:
                    self._data = json.load(f)
            except (OSError, ValueError):
                self._data = {}

    def get(self, key):
        with self._lock:
            entry = self._data.get(key)
            return dict(entry) if entry else None

    def set(self, key, J, frame):
        entry = {"matrix": [[float(v) for v in row] for row in J],
                 "frame": [int(frame[0]), int(frame[1])], "saved_at": time.time()}
        with self._lock:
            self._data[key] = entry
            self._save()
        return entry

    def delete(self, key):
        with self._lock:
            existed = self._data.pop(key, None) is not None
            self._save()
            return existed

    def _save(self):
        if not self.path:
            return
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self._data, f, indent=1)
        os.replace(tmp, self.path)   # atomic: never leaves a half-written file


_memory_store = MappingStore()   # default for callers that don't pass a store


class AlignError(RuntimeError):
    pass


class Cancelled(Exception):
    pass


def merge_settings(user=None):
    s = dict(ALIGN_DEFAULTS)
    for key, value in (user or {}).items():
        if key in _LIMITS:
            cast, lo, hi = _LIMITS[key]
            try:
                s[key] = min(hi, max(lo, cast(value)))
            except (TypeError, ValueError):
                pass
        elif key == "reuse_calibration":
            s[key] = bool(value)
    return s


def _image_dir(v):
    """Screen direction of an image-space vector (image y points down)."""
    if abs(v[0]) >= abs(v[1]):
        return "right" if v[0] > 0 else "left"
    return "down" if v[1] > 0 else "up"


def describe_mapping(J):
    """Human readable scale / rotation / mirror of a px-per-mm matrix."""
    det = float(np.linalg.det(J))
    return {
        "matrix": [[round(float(v), 3) for v in row] for row in J],
        "px_per_mm": round(math.sqrt(abs(det)), 2),
        "rotation_deg": round(math.degrees(math.atan2(J[1, 0], J[0, 0])), 2),
        "mirrored": det < 0,
        # Where the nozzle moves in the raw image for +X / +Y machine moves.
        "x_dir": _image_dir(J[:, 0]),
        "y_dir": _image_dir(J[:, 1]),
    }


def mapping_text(J):
    m = describe_mapping(J)
    return ("%(px_per_mm).0f px/mm; +X moves the image %(x_dir)s, +Y moves it %(y_dir)s "
            "(rotated %(rotation_deg).0f deg%(mir)s)" % dict(m, mir=", mirrored" if m["mirrored"] else ""))


class AutoAligner:
    """Runs one alignment. Thread-safe status via snapshot()."""

    def __init__(self, printer, camera, detect_params=None, settings=None,
                 target=None, camera_key=None, tool=None, mode="align", lock=None, store=None):
        self.printer = printer
        self.camera = camera
        self.detect_params = detect_params or {}
        self.settings = merge_settings(settings)
        self.target = None if target is None else np.array(target, float)
        self.camera_key = camera_key
        self.tool = tool
        self.mode = "orient" if mode == "orient" else "align"
        # Target the user locked in the live view: the first scan stays on it.
        self.initial_lock = lock if isinstance(lock, dict) else None
        self.store = store if store is not None else _memory_store
        self._frame = None
        self._settle_note = ""
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread = None
        self._status = {
            "state": "idle",      # idle|running|converged|not_converged|calibrated|failed|cancelled
            "mode": self.mode,
            "phase": None,
            "message": "",
            "tool": tool,
            "steps": [],
            "detection": None,
            "frame": None,
            "result": None,
            "start_position": None,
            "started": None,
            "finished": None,
        }

    # ------------------------------------------------------------- status
    def snapshot(self):
        with self._lock:
            out = dict(self._status)
            out["steps"] = list(self._status["steps"])
            return out

    def _set(self, **kw):
        with self._lock:
            self._status.update(kw)

    def _step(self, phase, message, **data):
        entry = {"t": round(time.time(), 3), "phase": phase, "message": message}
        entry.update(data)
        with self._lock:
            self._status["steps"].append(entry)
            self._status["phase"] = phase
            self._status["message"] = message

    @property
    def running(self):
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        self._thread = threading.Thread(target=self.run, name="axiscope-autoalign", daemon=True)
        self._thread.start()

    def cancel(self):
        self._cancel.set()

    def _check_cancel(self):
        if self._cancel.is_set():
            raise Cancelled()

    # ------------------------------------------------------------ helpers
    def _move(self, dx, dy):
        self._check_cancel()
        s = self.settings
        self.printer.move_relative(dx, dy, s["feed"], s["approach"])
        if s["settle"]:
            time.sleep(s["settle"])

    @staticmethod
    def _ring_lock(ref):
        """Lock on the reference nozzle's ring sizes, anywhere in the frame."""
        return {"rings": [r["r"] for r in ref["rings"]]} if ref else None

    def _track_lock(self, ref, predicted, expected_px):
        """Lock near where the nozzle should be after a move."""
        r_main = max(r["r"] for r in ref["rings"])
        radius = max(25.0, 0.3 * r_main + 0.5 * float(np.hypot(*expected_px)))
        return {"x": float(predicted[0]), "y": float(predicted[1]), "radius": radius,
                "rings": [r["r"] for r in ref["rings"]]}

    def _wait_stable(self, hint, ref, before, min_departure, lock=None):
        """After a move, grab frames until the image has caught up with it.

        Cameras buffer frames, so the first snapshots after a move can still
        show the old position, and two stale frames agree with each other.
        So first wait for the nozzle to leave `before` (when the move is big
        enough to see), then until two consecutive frames agree.
        Returns (frames used, settled?)."""
        timeout = self.settings["stable_timeout"]
        if timeout <= 0:
            return 0, True
        deadline = time.time() + timeout
        departed = min_departure <= 0 or before is None
        prev, frames = None, 0
        while time.time() < deadline:
            self._check_cancel()
            res = detect(self.camera.frame(), self.detect_params, hint=hint, lock=lock)
            frames += 1
            b = res["best"]
            if lock and res.get("locked") is False:
                b = None
            if b is None or (ref is not None and not self._same_nozzle(ref, b)):
                continue
            p = np.array([b["x"], b["y"]])
            tol = max(1.5, 0.01 * max(r["r"] for r in b["rings"]))
            if not departed and np.hypot(*(p - before)) > min_departure:
                departed = True
            elif departed and prev is not None and np.hypot(*(p - prev)) <= tol:
                return frames, True
            prev, hint = p, (b["x"], b["y"])
        return frames, False

    def _measure(self, hint=None, ref=None, before=None, min_departure=0.0, lock=None):
        """Median nozzle centre over several fresh frames, or None.

        With `before` set (a move just happened), first wait for the camera
        image to catch up with the move."""
        s = self.settings
        self._settle_note = ""
        if before is not None:
            frames, ok = self._wait_stable(hint, ref, before, min_departure, lock)
            if not ok:
                self._settle_note = " (image still changing after %.0f s)" % s["stable_timeout"]
            elif frames > 2:
                self._settle_note = " (camera caught up after %d frames)" % frames
        pts, last = [], None
        for i in range(s["samples"]):
            self._check_cancel()
            img = self.camera.frame()
            res = detect(img, self.detect_params, hint=hint, lock=lock)
            last = res
            b = res["best"]
            if lock and res.get("locked") is False:
                b = None   # the tracked nozzle is not in this frame; don't take another circle
            if b is not None and ref is not None and not self._same_nozzle(ref, b):
                b = None
            if b is not None:
                pts.append((b["x"], b["y"]))
                hint = (b["x"], b["y"])
        with self._lock:
            self._status["frame"] = {"width": last["width"], "height": last["height"]}
            self._status["detection"] = last["best"]
        need = (s["samples"] + 1) // 2
        if len(pts) < need:
            return None, last
        pts = np.array(pts)
        med = np.median(pts, axis=0)
        spread = float(np.max(np.hypot(*(pts - med).T))) if len(pts) > 1 else 0.0
        r_main = max(r["r"] for r in last["best"]["rings"]) if last and last["best"] else 0.0
        if spread > max(MAX_SAMPLE_SPREAD, SAMPLE_SPREAD_FRACTION * r_main):
            raise AlignError(
                "Frames disagree by %.1f px; the camera image is not stable "
                "(vibration, stale frames or a second circle in view)." % spread)
        return med, last

    @staticmethod
    def _same_nozzle(ref, b):
        """Guard against jumping to another circle: at least one ring radius
        must match. (Not "the largest ring": outer rings come and go when the
        nozzle nears the frame edge or the edge is rough.)"""
        shared = sum(1 for ra in ref["rings"]
                     if any(abs(ra["r"] - rb["r"]) <= max(3.0, 0.08 * ra["r"]) for rb in b["rings"]))
        # One equal radius can be a coincidence (a screw head, a bearing);
        # two matching rings make it the same part.
        return shared >= min(2, len(ref["rings"]), len(b["rings"]))

    def _probe(self, axis, p_from, ref):
        """Move `axis` by the probe distance, return (image delta per mm, new pixel)."""
        d = self.settings["probe_distance"]
        for sign in (1.0, -1.0):
            move = np.zeros(2)
            # The retry on the opposite side has to undo the first probe too.
            move[axis] = d * sign if sign > 0 else -2.0 * d
            self._move(*move)
            # Expect the image to move at least a few pixels for a probe move.
            p, _ = self._measure(hint=None, ref=ref, before=p_from, min_departure=3.0,
                                 lock=self._ring_lock(ref))
            if p is not None:
                return (p - p_from) / (d * sign), p
            self._step("probe_%s" % "xy"[axis],
                       "Nozzle left the view after %+.2f mm %s, trying the other side"
                       % (d * sign, "XY"[axis]))
        # Return to where the probe started.
        self._move(*(np.eye(2)[axis] * d))
        raise AlignError("Nozzle not found after probing %s in both directions. "
                         "Lower the probe distance or centre the nozzle roughly first."
                         % "XY"[axis])

    def _calibrate(self, p0, ref):
        jx, p1 = self._probe(0, p0, ref)
        self._step("probe_x", "Probe X: %.1f px/mm, image moved %s%s"
                   % (np.hypot(*jx), _image_dir(jx), self._settle_note),
                   px=[round(float(v), 2) for v in p1], position=self.printer.position())
        jy, p2 = self._probe(1, p1, ref)
        self._step("probe_y", "Probe Y: %.1f px/mm, image moved %s%s"
                   % (np.hypot(*jy), _image_dir(jy), self._settle_note),
                   px=[round(float(v), 2) for v in p2], position=self.printer.position())
        J = np.column_stack([jx, jy])
        self._validate(J)
        return J, p2

    @staticmethod
    def _validate(J):
        nx, ny = np.hypot(*J[:, 0]), np.hypot(*J[:, 1])
        if min(nx, ny) < MIN_PX_PER_MM:
            raise AlignError(
                "The tracked circle barely moved in the image (%.1f / %.1f px per mm), so it "
                "is not on the moving nozzle. Click the nozzle in the camera image to lock onto "
                "it, and check that the camera feed is live." % (nx, ny))
        cos = abs(float(J[:, 0] @ J[:, 1])) / (nx * ny)
        skew = 90.0 - math.degrees(math.acos(min(1.0, cos)))
        if skew > MAX_SKEW_DEG:
            raise AlignError("X and Y moves look %.0f degrees from perpendicular in "
                             "the image; the measurement is unreliable." % (90 - skew))
        if max(nx, ny) / min(nx, ny) > 1.5:
            raise AlignError("X and Y scales differ (%.1f vs %.1f px/mm); the "
                             "measurement is unreliable." % (nx, ny))

    # --------------------------------------------------------------- run
    def run(self):
        self._set(state="running", started=time.time())
        try:
            result = self._run()
            if self.mode == "orient":
                state = "calibrated"
            else:
                state = "converged" if result["converged"] else "not_converged"
            self._set(state=state, result=result, finished=time.time())
        except Cancelled:
            self._step("cancelled", "Cancelled; the toolhead stays where it is.")
            self._set(state="cancelled", finished=time.time())
        except Exception as e:  # noqa: BLE001 - every failure must reach the UI
            self._step("failed", str(e))
            self._set(state="failed", message=str(e), finished=time.time())

    def _run(self):
        s = self.settings
        homed = self.printer.homed_axes()
        if "x" not in homed or "y" not in homed:
            raise AlignError("Home X and Y before auto alignment.")

        start = self.printer.position()
        self._set(start_position=start)

        self._step("scan", "Scanning for concentric circles")
        p, res = self._measure(lock=self.initial_lock)
        if p is None:
            msg = "No nozzle found in the camera view."
            if res and res.get("warning"):
                msg += " " + res["warning"]
            raise AlignError(msg + " Adjust the radius range or edge thresholds.")
        ref = res["best"]
        self._frame = (res["width"], res["height"])
        if self.target is None:
            self.target = np.array([res["width"] / 2.0, res["height"] / 2.0])
        rings = ", ".join("%.0f" % r["r"] for r in ref["rings"])
        self._step("scan", "Nozzle at (%.1f, %.1f) px, rings r=%s px" % (p[0], p[1], rings),
                   px=[round(float(v), 2) for v in p])

        if self.mode == "orient":
            return self._orient(start, p, ref)

        J = self._saved_mapping() if s["reuse_calibration"] else None
        check_saved = J is not None
        if J is not None:
            self._step("calibration", "Using saved camera mapping: " + mapping_text(J)
                       + ". The first move checks it.", mapping=describe_mapping(J))
        else:
            J, p = self._calibrate(p, ref)
            self._remember(J)
            self._step("calibration", "Mapping: " + mapping_text(J), mapping=describe_mapping(J))

        converged = False
        corrections = 0
        err_mm = None
        last_err, worse = None, 0
        while True:
            err_px = self.target - p
            move = np.linalg.solve(J, err_px)
            err_mm = float(np.hypot(*move))
            # Safety: corrections that keep making things worse mean the
            # mapping or the detection is wrong. Stop instead of wandering.
            if last_err is not None and err_mm > s["tolerance"] * 3:
                if err_mm > last_err * 3:
                    worse = 2
                elif err_mm > last_err * 1.2:
                    worse += 1
                else:
                    worse = 0
                if worse >= 2:
                    raise AlignError(
                        "Corrections are making it worse (error %.3f -> %.3f mm), so the "
                        "run stopped. Learned mapping: %s. If the nozzle visibly moved "
                        "differently, the detection is tracking something else or the camera "
                        "image lags; try a higher Settle time or tighter radius range."
                        % (last_err, err_mm, mapping_text(J)))
            last_err = err_mm
            if err_mm <= s["tolerance"]:
                converged = True
                self._step("verify", "Within tolerance: %.4f mm (%.2f px)"
                           % (err_mm, np.hypot(*err_px)),
                           error_mm=round(err_mm, 4), position=self.printer.position())
                break
            if corrections >= s["max_iterations"]:
                self._step("verify", "Still %.4f mm off after %d corrections"
                           % (err_mm, corrections), error_mm=round(err_mm, 4))
                break
            if err_mm > s["max_move"]:
                raise AlignError("Correction of %.2f mm exceeds the %.2f mm safety limit. "
                                 "Jog the nozzle closer to the crosshair first."
                                 % (err_mm, s["max_move"]))
            if check_saved and np.hypot(*move) > s["probe_distance"]:
                # A saved mapping might be stale (camera bumped or turned):
                # take a short step first and see if the image agrees.
                move = move * (s["probe_distance"] / float(np.hypot(*move)))
            corrections += 1
            self._step("correct", "Correction %d/%d: X%+.4f Y%+.4f mm (error %.4f mm)"
                       % (corrections, s["max_iterations"], move[0], move[1], err_mm),
                       move=[round(float(v), 4) for v in move], error_mm=round(err_mm, 4))
            self._move(*move)
            expected = J @ move
            predicted = p + expected
            if check_saved:
                # The prediction comes from the mapping under test, so look for
                # the nozzle by its rings anywhere instead of where it "should" be.
                p_new, _ = self._measure(ref=ref, before=p, lock=self._ring_lock(ref),
                                         min_departure=3.0)
            else:
                p_new, _ = self._measure(hint=tuple(predicted), ref=ref, before=p,
                                         lock=self._track_lock(ref, predicted, expected),
                                         min_departure=0.5 * float(np.hypot(*expected)))
            if p_new is None:
                raise AlignError("Lost the nozzle after correction %d." % corrections)
            observed = p_new - p
            self._step("observe", "Image moved %.1f px %s (expected %.1f px %s)%s"
                       % (np.hypot(*observed), _image_dir(observed),
                          np.hypot(*expected), _image_dir(expected), self._settle_note),
                       observed_px=[round(float(v), 2) for v in observed],
                       expected_px=[round(float(v), 2) for v in expected])
            if check_saved:
                check_saved = False
                big = np.hypot(*expected) >= 8.0
                off = np.hypot(*(observed - expected)) / max(1e-9, float(np.hypot(*expected)))
                if big and off > MAPPING_CHECK_TOLERANCE:
                    self._step("calibration", "Saved mapping no longer matches the camera "
                               "(%.0f%% off); measuring it again." % (off * 100))
                    J, p = self._calibrate(p_new, ref)
                    self._remember(J)
                    self._step("calibration", "Mapping: " + mapping_text(J),
                               mapping=describe_mapping(J))
                    corrections -= 1   # the check step doesn't count as a correction
                    last_err, worse = None, 0
                    continue
            # Broyden update from the observed motion, if the move was big enough
            # for the image delta to carry information beyond detection noise.
            if np.hypot(*move) * describe_mapping(J)["px_per_mm"] > 4.0:
                dp = p_new - p
                J_new = J + np.outer(dp - J @ move, move) / float(move @ move)
                try:
                    self._validate(J_new)
                    J = J_new
                except AlignError:
                    pass
            p = p_new

        if converged:
            self._remember(J)   # refined by the corrections

        final = self.printer.position()
        residual_px = self.target - p
        return {
            "converged": converged,
            "corrections": corrections,
            "error_mm": round(err_mm, 4),
            "error_px": round(float(np.hypot(*residual_px)), 2),
            "tolerance": s["tolerance"],
            "start_position": start,
            "final_position": final,
            "moved_mm": [round(final[0] - start[0], 4), round(final[1] - start[1], 4)],
            "nozzle_px": [round(float(v), 2) for v in p],
            "target_px": [round(float(v), 2) for v in self.target],
            "rings": ref["rings"],
            "mapping": describe_mapping(J),
        }

    def _orient(self, start, p0, ref):
        """Control moves only: learn how machine moves look in the image, then
        go back to the start and check the nozzle returns to the same pixel."""
        J, p = self._calibrate(p0, ref)
        self._step("calibration", "Mapping: " + mapping_text(J), mapping=describe_mapping(J))
        pos = self.printer.position()
        back = np.array([start[0] - pos[0], start[1] - pos[1]])
        self._step("return", "Moving back to the start: X%+.3f Y%+.3f mm" % tuple(back))
        self._move(*back)
        expected = J @ back
        p_back, _ = self._measure(hint=tuple(p + expected), ref=ref, before=p,
                                  lock=self._track_lock(ref, p + expected, expected),
                                  min_departure=0.5 * float(np.hypot(*expected)))
        if p_back is None:
            raise AlignError("Lost the nozzle when moving back to the start.")
        ret_px = float(np.hypot(*(p_back - p0)))
        ret_mm = ret_px / describe_mapping(J)["px_per_mm"]
        r_main = max(r["r"] for r in ref["rings"])
        consistent = ret_px <= max(3.0, 0.02 * r_main)
        self._step("verify", "Back at start: nozzle %.1f px (%.4f mm) from where it began%s%s"
                   % (ret_px, ret_mm, self._settle_note,
                      "" if consistent else ". That is more than expected: check for backlash, "
                      "a loose camera or image lag (raise Settle time)."),
                   return_px=round(ret_px, 2))
        self._remember(J)
        return {
            "mode": "orient",
            "mapping": describe_mapping(J),
            "return_error_px": round(ret_px, 2),
            "return_error_mm": round(ret_mm, 4),
            "consistent": consistent,
            "start_position": start,
            "final_position": self.printer.position(),
            "rings": ref["rings"],
        }

    def _saved_mapping(self):
        """Saved matrix for this camera, if it was measured at this resolution."""
        if self.camera_key is None:
            return None
        entry = self.store.get(self.camera_key)
        if not entry or list(entry.get("frame", [])) != [int(v) for v in self._frame]:
            return None
        J = np.array(entry["matrix"], dtype=float)
        try:
            self._validate(J)
        except AlignError:
            return None
        return J

    def _remember(self, J):
        if self.camera_key is not None and self._frame:
            self.store.set(self.camera_key, J, self._frame)

    def revert(self):
        """Move back to the position the alignment started from."""
        start = self.snapshot()["start_position"]
        if not start:
            raise AlignError("Nothing to revert.")
        s = self.settings
        self.printer.move_absolute(start[0], start[1], s["feed"], s["approach"])
        return start
