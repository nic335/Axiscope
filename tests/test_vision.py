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
