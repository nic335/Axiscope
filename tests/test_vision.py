"""Detector and auto-align tests on synthetic images. Run: python -m pytest tests"""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from synthetic import SimRig, render_nozzle  # noqa: E402
from axiscope_vision.align import AutoAligner, merge_settings  # noqa: E402
from axiscope_vision.detect import detect, merge_params  # noqa: E402

PARAMS = {"max_radius": 150}
FAST = {"settle": 0}


@pytest.mark.parametrize("seed", range(10))
def test_detects_concentric_centre_subpixel(seed):
    rng = np.random.default_rng(seed)
    cx, cy = rng.uniform(200, 1080), rng.uniform(150, 570)
    best = detect(render_nozzle(cx, cy, seed=seed), PARAMS)["best"]
    assert best is not None and best["concentric"]
    assert len(best["rings"]) >= 2
    assert np.hypot(best["x"] - cx, best["y"] - cy) < 0.3


@pytest.mark.parametrize("kind", ["blank", "noise", "texture"])
def test_rejects_frames_without_nozzle(kind):
    import cv2
    rng = np.random.default_rng(3)
    if kind == "blank":
        img = np.full((720, 1280, 3), 60, np.uint8)
    else:
        img = rng.integers(0, 255, (720, 1280, 3), dtype=np.uint8)
        if kind == "texture":
            img = cv2.GaussianBlur(img, (0, 0), 3)
    assert detect(img, PARAMS)["best"] is None


def test_single_ring_needs_opt_in():
    # Orifice only, no face ring: a single circle.
    img = render_nozzle(640, 360, r_tip=1, r_face=1, r_hole=40, seed=1)
    assert detect(img, PARAMS)["best"] is None
    best = detect(img, dict(PARAMS, require_concentric=False))["best"]
    assert best is not None and np.hypot(best["x"] - 640, best["y"] - 360) < 0.5


def test_param_validation_clamps():
    p = merge_params({"min_radius": 50, "max_radius": 10, "canny_low": "x", "bogus": 1})
    assert p["max_radius"] > p["min_radius"]
    assert p["canny_low"] == 40 and "bogus" not in p
    s = merge_settings({"max_iterations": 999, "tolerance": -1})
    assert s["max_iterations"] == 25 and s["tolerance"] == 0.001


@pytest.mark.parametrize("rig_kw", [
    {},
    {"angle_deg": -95, "mirror": False, "px_per_mm": 250},
    {"angle_deg": 180, "mirror": True, "px_per_mm": 500, "start": (150.2, 149.9)},
    {"backlash": 0.03, "start": (150.3, 149.8)},
])
def test_autoalign_converges_for_any_camera_orientation(rig_kw):
    rig = SimRig(**rig_kw)
    a = AutoAligner(rig, rig, PARAMS, dict(FAST, tolerance=0.005))
    a.run()
    st = a.snapshot()
    assert st["state"] == "converged", st["message"]
    true_err = np.hypot(*(rig.nozzle_px() - [rig.w / 2, rig.h / 2])) / rig.A[0].dot(rig.A[0]) ** 0.5
    assert true_err < 0.006
    # Probe X, probe Y, then at most a couple of corrections.
    assert st["result"]["corrections"] <= 3


class NoisyMoves(SimRig):
    """Every move lands up to 20 um off target: the loop can never reach 1 um."""

    def move_relative(self, dx, dy, feed, approach):
        jitter = np.random.default_rng(len(self.moves)).uniform(-0.02, 0.02, 2)
        super().move_relative(dx + jitter[0], dy + jitter[1], feed, approach)


def test_autoalign_stops_after_max_iterations():
    rig = NoisyMoves()
    a = AutoAligner(rig, rig, PARAMS, dict(FAST, tolerance=0.001, max_iterations=3))
    a.run()
    st = a.snapshot()
    assert st["state"] == "not_converged"
    assert st["result"]["corrections"] == 3
    assert len(rig.moves) == 2 + 3  # two probes + N corrections, nothing more


def test_autoalign_refuses_large_corrections():
    rig = SimRig(start=(150.4, 149.7))
    a = AutoAligner(rig, rig, PARAMS, dict(FAST, max_move=0.2))
    a.run()
    st = a.snapshot()
    assert st["state"] == "failed" and "safety limit" in st["message"]


def test_autoalign_requires_homing():
    rig = SimRig()
    rig.homed_axes = lambda: "z"
    a = AutoAligner(rig, rig, PARAMS, FAST)
    a.run()
    assert a.snapshot()["state"] == "failed"
    assert rig.moves == []


def test_autoalign_fails_cleanly_without_nozzle():
    rig = SimRig(start=(152.0, 150.0))  # 2 mm away: outside the field of view
    a = AutoAligner(rig, rig, PARAMS, FAST)
    a.run()
    st = a.snapshot()
    assert st["state"] == "failed" and "No nozzle" in st["message"]
    assert rig.moves == []


def test_probe_retries_opposite_direction_near_edge():
    # Nozzle near the right edge: +X probe pushes it out of view (mapping has +x -> +px).
    rig = SimRig(start=(151.5, 150.0), angle_deg=0, mirror=False, px_per_mm=380)
    a = AutoAligner(rig, rig, PARAMS, dict(FAST, max_move=3.0))
    a.run()
    st = a.snapshot()
    assert st["state"] == "converged", st["message"]
    assert any("other side" in s["message"] for s in st["steps"])


def test_reuse_calibration_skips_probe_moves():
    rig = SimRig()
    AutoAligner(rig, rig, PARAMS, FAST, camera_key="cam").run()
    rig2 = SimRig(start=(150.3, 149.8))
    a = AutoAligner(rig2, rig2, PARAMS, dict(FAST, reuse_calibration=True), camera_key="cam")
    a.run()
    assert a.snapshot()["state"] == "converged"
    assert len(rig2.moves) == a.snapshot()["result"]["corrections"]


def test_cancel_and_revert():
    rig = SimRig()
    a = AutoAligner(rig, rig, PARAMS, FAST)
    a.cancel()
    a.run()
    assert a.snapshot()["state"] == "cancelled"
    rig2 = SimRig()
    a2 = AutoAligner(rig2, rig2, PARAMS, FAST)
    a2.run()
    start = a2.snapshot()["start_position"]
    a2.revert()
    assert np.allclose(rig2.position()[:2], start[:2])


@pytest.mark.parametrize("angle", [0, 90, 180, 270])
@pytest.mark.parametrize("mirror", [False, True])
def test_autoalign_any_quarter_turn_camera(angle, mirror):
    # e.g. a camera mounted 90 deg: X- moves the image down.
    rig = SimRig(angle_deg=angle, mirror=mirror, start=(150.3, 149.8))
    a = AutoAligner(rig, rig, PARAMS, dict(FAST, tolerance=0.005))
    a.run()
    st = a.snapshot()
    assert st["state"] == "converged", st["message"]
    m = st["result"]["mapping"]
    assert m["mirrored"] == mirror
    assert any("+X moves the image" in s["message"] for s in st["steps"])


class LaggyCamera(SimRig):
    """After every move the camera keeps serving the old picture for a few frames."""

    def __init__(self, lag=3, **kw):
        super().__init__(**kw)
        self.lag = lag
        self.stale = None
        self.stale_left = 0

    def _go(self, target):
        if self.stale_left == 0:
            self.stale = self.nozzle_px()
        self.stale_left = self.lag
        super()._go(target)

    def frame(self):
        if self.stale_left > 0:
            self.stale_left -= 1
            self.frame_no += 1
            from synthetic import render_nozzle
            return render_nozzle(*self.stale, self.w, self.h, seed=self.seed + self.frame_no)
        return super().frame()


def test_autoalign_waits_for_lagging_camera():
    rig = LaggyCamera(lag=3, angle_deg=90, start=(150.3, 149.8))
    a = AutoAligner(rig, rig, PARAMS, dict(FAST, tolerance=0.005))
    a.run()
    st = a.snapshot()
    assert st["state"] == "converged", st["message"]
    assert abs(st["result"]["mapping"]["px_per_mm"] - 380) < 10   # learned from fresh frames
    assert st["result"]["corrections"] <= 3


def test_lagging_camera_without_wait_is_caught_not_wandering():
    # With the wait disabled the stale frames corrupt the mapping; the run
    # must end in a clear state, never by drifting off unchecked.
    rig = LaggyCamera(lag=3, angle_deg=90, start=(150.3, 149.8))
    a = AutoAligner(rig, rig, PARAMS, dict(FAST, tolerance=0.005, stable_timeout=0, max_move=1.0))
    a.run()
    st = a.snapshot()
    assert st["state"] in ("failed", "converged", "not_converged")
    assert np.hypot(*(rig.pos - np.array([150.3, 149.8]))) < 2.0


class WrongWay(SimRig):
    """After the probes, the printer moves the opposite way (as if axes were swapped)."""

    def move_relative(self, dx, dy, feed, approach):
        if len(self.moves) >= 2:
            dx, dy = -dx * 2.5, -dy * 2.5
        super().move_relative(dx, dy, feed, approach)


def test_stops_when_corrections_make_it_worse():
    rig = WrongWay(start=(150.05, 149.97))
    a = AutoAligner(rig, rig, PARAMS, dict(FAST, tolerance=0.002, max_iterations=10, max_move=3.0))
    a.run()
    st = a.snapshot()
    assert st["state"] == "failed"
    assert "worse" in st["message"] or "safety" in st["message"] or "Lost" in st["message"]
    assert len(rig.moves) <= 2 + 4   # stopped early, did not use all 10 corrections


@pytest.mark.parametrize("angle,mirror,x_dir,y_dir", [
    (0, True, "right", "up"),      # image y points down, so mirrored Y = "up"
    (90, True, "down", "right"),   # the reported case: X- moves the image up/down
    (90, False, "down", "left"),
    (180, False, "left", "up"),
])
def test_orient_reports_directions_and_returns_home(angle, mirror, x_dir, y_dir):
    rig = SimRig(angle_deg=angle, mirror=mirror, start=(150.2, 149.9))
    start = rig.position()
    a = AutoAligner(rig, rig, PARAMS, FAST, mode="orient")
    a.run()
    st = a.snapshot()
    assert st["state"] == "calibrated", st["message"]
    m = st["result"]["mapping"]
    assert (m["x_dir"], m["y_dir"]) == (x_dir, y_dir)
    assert st["result"]["consistent"]
    assert np.allclose(rig.position()[:2], start[:2], atol=1e-6)   # back where it started


def test_tracking_survives_rings_appearing_at_frame_edge():
    # Reported case: 90 deg camera, the outer ring is clipped by the frame edge
    # at the start and comes into view after the probe move.
    rig = SimRig(angle_deg=90, mirror=True, start=(150.25, 149.8))
    a = AutoAligner(rig, rig, PARAMS, FAST)
    a.run()
    st = a.snapshot()
    assert st["state"] == "converged", st["message"]


# --- target lock: a stronger circle elsewhere must not steal the target ---
import cv2  # noqa: E402

DECOY = (1050.0, 180.0)


def add_decoy(img):
    # A static, high-contrast concentric target (e.g. a screw head) with more
    # rings than the nozzle, so it outscores it when nothing is locked.
    for r, v in ((70, 230), (52, 20), (36, 230), (22, 20), (10, 230)):
        cv2.circle(img, (int(DECOY[0]), int(DECOY[1])), r, (v, v, v), -1, cv2.LINE_AA)
    return img


class DecoyRig(SimRig):
    def frame(self):
        return add_decoy(super().frame())


def test_unlocked_detection_prefers_the_decoy():
    img = add_decoy(render_nozzle(500, 420, seed=3))
    best = detect(img, PARAMS)["best"]
    assert np.hypot(best["x"] - DECOY[0], best["y"] - DECOY[1]) < 3   # the problem


def test_lock_keeps_the_nozzle_over_a_stronger_circle():
    img = add_decoy(render_nozzle(500, 420, seed=3))
    out = detect(img, PARAMS, lock={"x": 505, "y": 415, "radius": 60})
    assert out["locked"] is True
    assert np.hypot(out["best"]["x"] - 500, out["best"]["y"] - 420) < 0.5
    # A lock on ring sizes alone (no position) also picks the nozzle.
    out = detect(img, PARAMS, lock={"rings": [16, 55, 90]})
    assert np.hypot(out["best"]["x"] - 500, out["best"]["y"] - 420) < 0.5


def test_lock_lost_falls_back_and_reports_it():
    img = add_decoy(render_nozzle(500, 420, seed=3))
    out = detect(img, PARAMS, lock={"x": 200, "y": 600, "radius": 40})
    assert out["locked"] is False and out["best"] is not None


def test_autoalign_stays_on_locked_nozzle_with_decoy_in_view():
    rig = DecoyRig(start=(150.3, 149.8))
    p0 = rig.nozzle_px()
    a = AutoAligner(rig, rig, PARAMS, dict(FAST, tolerance=0.005),
                    lock={"x": float(p0[0]), "y": float(p0[1]), "radius": 60})
    a.run()
    st = a.snapshot()
    assert st["state"] == "converged", st["message"]
    assert np.hypot(*(rig.nozzle_px() - [rig.w / 2, rig.h / 2])) < 3


def test_probe_out_of_view_with_decoy_retries_instead_of_taking_decoy():
    # Reported sequence: nozzle near the frame edge, a stronger circle in view.
    # The +X probe pushes the nozzle out; the run must not jump to the decoy.
    rig = DecoyRig(angle_deg=90, mirror=True, start=(150.7, 149.8))
    p0 = rig.nozzle_px()
    a = AutoAligner(rig, rig, PARAMS, dict(FAST, tolerance=0.005),
                    lock={"x": float(p0[0]), "y": float(p0[1]), "radius": 60})
    a.run()
    st = a.snapshot()
    assert st["state"] == "converged", st["message"]
    assert any("other side" in s["message"] for s in st["steps"])
    assert np.hypot(*(rig.nozzle_px() - [rig.w / 2, rig.h / 2])) < 3


# --- saved camera mapping ---
from axiscope_vision.align import MappingStore  # noqa: E402


def test_mapping_store_persists_to_disk(tmp_path):
    path = str(tmp_path / "sub" / "mappings.json")
    MappingStore(path).set("cam", [[380.0, 0.0], [0.0, -380.0]], (1280, 720))
    entry = MappingStore(path).get("cam")
    assert entry["matrix"] == [[380.0, 0.0], [0.0, -380.0]] and entry["frame"] == [1280, 720]
    assert MappingStore(path).delete("cam") and MappingStore(path).get("cam") is None


def test_saved_mapping_skips_probes_and_is_refreshed_when_stale():
    store = MappingStore()
    rig = SimRig(angle_deg=90, mirror=True)
    AutoAligner(rig, rig, PARAMS, FAST, camera_key="cam", store=store).run()
    saved = np.array(store.get("cam")["matrix"])
    # Second tool: the saved mapping is used, no probe moves.
    rig2 = SimRig(angle_deg=90, mirror=True, start=(150.3, 149.8))
    a = AutoAligner(rig2, rig2, PARAMS, dict(FAST, tolerance=0.005), camera_key="cam", store=store)
    a.run()
    st = a.snapshot()
    assert st["state"] == "converged", st["message"]
    assert any("Using saved camera mapping" in s["message"] for s in st["steps"])
    assert not any(s["phase"].startswith("probe") for s in st["steps"])
    # Camera turned 90 degrees since: the check step notices and re-maps.
    rig3 = SimRig(angle_deg=0, mirror=True, start=(150.3, 149.8))
    a = AutoAligner(rig3, rig3, PARAMS, dict(FAST, tolerance=0.005), camera_key="cam", store=store)
    a.run()
    st = a.snapshot()
    assert st["state"] == "converged", st["message"]
    assert any("no longer matches" in s["message"] for s in st["steps"])
    assert not np.allclose(np.array(store.get("cam")["matrix"]), saved, atol=20)
    # The check step was capped to the probe distance.
    assert np.hypot(*rig3.moves[0]) <= 0.5 + 1e-9


def test_saved_mapping_ignored_at_other_resolution():
    store = MappingStore()
    store.set("cam", [[380.0, 0.0], [0.0, -380.0]], (1920, 1080))
    rig = SimRig(mirror=True, start=(150.3, 149.8))     # 1280x720
    a = AutoAligner(rig, rig, PARAMS, FAST, camera_key="cam", store=store)
    a.run()
    st = a.snapshot()
    assert st["state"] == "converged"
    assert any(s["phase"] == "probe_x" for s in st["steps"])
    assert store.get("cam")["frame"] == [1280, 720]
