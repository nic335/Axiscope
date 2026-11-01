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
import math
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
    "samples": 3,             # frames per measurement (median)
    "feed": 10.0,             # mm/s
    "approach": 0.0,          # mm backlash approach (0 disables)
    "reuse_calibration": False,
}

_LIMITS = {
    "max_iterations": (int, 1, 25),
    "tolerance": (float, 0.001, 0.5),
    "probe_distance": (float, 0.05, 3.0),
    "max_move": (float, 0.1, 20.0),
    "settle": (float, 0.0, 5.0),
    "samples": (int, 1, 9),
    "feed": (float, 1.0, 100.0),
    "approach": (float, 0.0, 2.0),
}

MIN_PX_PER_MM = 10.0       # less than this and the camera is not seeing motion
MAX_SKEW_DEG = 30.0        # probe axes must be roughly perpendicular in the image
MAX_SAMPLE_SPREAD = 3.0    # px floor; frames of one measurement must agree
SAMPLE_SPREAD_FRACTION = 0.03  # ...or within 3% of the main ring radius

# Last good mapping per camera URL, reused when reuse_calibration is set.
_calibration_cache = {}


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


def describe_mapping(J):
    """Human readable scale / rotation / mirror of a px-per-mm matrix."""
    det = float(np.linalg.det(J))
    return {
        "matrix": [[round(float(v), 3) for v in row] for row in J],
        "px_per_mm": round(math.sqrt(abs(det)), 2),
        "rotation_deg": round(math.degrees(math.atan2(J[1, 0], J[0, 0])), 2),
        "mirrored": det < 0,
    }


class AutoAligner:
    """Runs one alignment. Thread-safe status via snapshot()."""

    def __init__(self, printer, camera, detect_params=None, settings=None,
                 target=None, camera_key=None, tool=None):
        self.printer = printer
        self.camera = camera
        self.detect_params = detect_params or {}
        self.settings = merge_settings(settings)
        self.target = None if target is None else np.array(target, float)
        self.camera_key = camera_key
        self.tool = tool
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread = None
        self._status = {
            "state": "idle",      # idle|running|converged|not_converged|failed|cancelled
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

    def _measure(self, hint=None, ref=None):
        """Median nozzle centre over several fresh frames, or None."""
        s = self.settings
        pts, last = [], None
        for i in range(s["samples"]):
            self._check_cancel()
            img = self.camera.frame()
            res = detect(img, self.detect_params, hint=hint)
            last = res
            b = res["best"]
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
        """Guard against jumping to another circle: largest ring must match."""
        ra = max(r["r"] for r in ref["rings"])
        rb = max(r["r"] for r in b["rings"])
        return abs(ra - rb) <= max(4.0, 0.15 * ra)

    def _probe(self, axis, p_from, ref):
        """Move `axis` by the probe distance, return (image delta per mm, new pixel)."""
        d = self.settings["probe_distance"]
        for sign in (1.0, -1.0):
            move = np.zeros(2)
            # The retry on the opposite side has to undo the first probe too.
            move[axis] = d * sign if sign > 0 else -2.0 * d
            self._move(*move)
            p, _ = self._measure(hint=None, ref=ref)
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
        self._step("probe_x", "Probe X: %.1f px/mm" % np.hypot(*jx),
                   px=[round(float(v), 2) for v in p1], position=self.printer.position())
        jy, p2 = self._probe(1, p1, ref)
        self._step("probe_y", "Probe Y: %.1f px/mm" % np.hypot(*jy),
                   px=[round(float(v), 2) for v in p2], position=self.printer.position())
        J = np.column_stack([jx, jy])
        self._validate(J)
        return J, p2

    @staticmethod
    def _validate(J):
        nx, ny = np.hypot(*J[:, 0]), np.hypot(*J[:, 1])
        if min(nx, ny) < MIN_PX_PER_MM:
            raise AlignError(
                "The nozzle barely moved in the image (%.1f / %.1f px per mm). "
                "Is the camera feed live, and is this the nozzle camera?" % (nx, ny))
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
        p, res = self._measure()
        if p is None:
            msg = "No nozzle found in the camera view."
            if res and res.get("warning"):
                msg += " " + res["warning"]
            raise AlignError(msg + " Adjust the radius range or edge thresholds.")
        ref = res["best"]
        if self.target is None:
            self.target = np.array([res["width"] / 2.0, res["height"] / 2.0])
        rings = ", ".join("%.0f" % r["r"] for r in ref["rings"])
        self._step("scan", "Nozzle at (%.1f, %.1f) px, rings r=%s px" % (p[0], p[1], rings),
                   px=[round(float(v), 2) for v in p])

        J = None
        if s["reuse_calibration"] and self.camera_key in _calibration_cache:
            J = _calibration_cache[self.camera_key].copy()
            self._step("calibration", "Reusing camera calibration (%.1f px/mm)"
                       % describe_mapping(J)["px_per_mm"])
        else:
            J, p = self._calibrate(p, ref)
        self._step("calibration", "Mapping: %(px_per_mm).1f px/mm, rotated %(rotation_deg).1f deg"
                   % describe_mapping(J) + (", mirrored" if np.linalg.det(J) < 0 else ""))

        converged = False
        corrections = 0
        err_mm = None
        while True:
            err_px = self.target - p
            move = np.linalg.solve(J, err_px)
            err_mm = float(np.hypot(*move))
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
            corrections += 1
            self._step("correct", "Correction %d/%d: X%+.4f Y%+.4f mm (error %.4f mm)"
                       % (corrections, s["max_iterations"], move[0], move[1], err_mm),
                       move=[round(float(v), 4) for v in move], error_mm=round(err_mm, 4))
            self._move(*move)
            predicted = p + J @ move
            p_new, _ = self._measure(hint=tuple(predicted), ref=ref)
            if p_new is None:
                raise AlignError("Lost the nozzle after correction %d." % corrections)
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

        if self.camera_key is not None:
            _calibration_cache[self.camera_key] = J.copy()

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

    def revert(self):
        """Move back to the position the alignment started from."""
        start = self.snapshot()["start_position"]
        if not start:
            raise AlignError("Nothing to revert.")
        s = self.settings
        self.printer.move_absolute(start[0], start[1], s["feed"], s["approach"])
        return start
