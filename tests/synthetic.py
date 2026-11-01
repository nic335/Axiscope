"""Synthetic nozzle images and a simulated printer/camera for tests."""
import math

import cv2
import numpy as np


def render_nozzle(cx, cy, w=1280, h=720, r_tip=90, r_face=55, r_hole=16, noise=6.0, seed=None):
    """Render a top-down nozzle: hex body, bright tip face, dark orifice."""
    rng = np.random.default_rng(seed)
    img = np.full((h, w), 45, np.float32)
    yy, xx = np.mgrid[0:h, 0:w]
    img += 25 * np.exp(-(((xx - w / 2) ** 2 + (yy - h / 2) ** 2) / (2 * (0.6 * w) ** 2)))
    hexagon = np.array([[cx + 1.9 * r_tip * math.cos(a), cy + 1.9 * r_tip * math.sin(a)]
                        for a in np.linspace(0, 2 * math.pi, 7)[:-1] + 0.3], np.int32)
    canvas = img.copy()
    cv2.fillPoly(canvas, [hexagon], 85)
    S = 4  # supersample circles for sub-pixel accurate edges
    hi = np.zeros((h * S, w * S), np.uint8)
    # INTER_AREA maps hi-res pixel centre i to (i + 0.5) / S - 0.5; invert that.
    F = 16  # cv2 fixed-point fractional bits (shift=4)
    c = (int(round(((cx + 0.5) * S - 0.5) * F)), int(round(((cy + 0.5) * S - 0.5) * F)))
    for r, v in ((r_tip, 120), (r_face, 190), (r_hole, 12)):
        cv2.circle(hi, c, int(r * S * F), v, -1, cv2.LINE_AA, shift=4)
    lo = cv2.resize(hi, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32)
    mask = cv2.resize((hi > 0).astype(np.float32), (w, h), interpolation=cv2.INTER_AREA)
    img = canvas * (1 - mask) + lo * mask
    img = cv2.GaussianBlur(img, (0, 0), 1.2)
    img += rng.normal(0, noise, img.shape)
    img = np.clip(img, 0, 255).astype(np.uint8)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


class SimRig:
    """A printer whose nozzle is seen by a camera with an unknown mapping.

    pixel = centre + A @ (nozzle_xy - camera_xy)
    A includes scale, rotation and an optional mirror; moves can have
    backlash and the detector sees sensor noise.
    """

    def __init__(self, start=(150.4, 149.7), camera=(150.0, 150.0), px_per_mm=380.0,
                 angle_deg=7.0, mirror=True, backlash=0.0, tool_offset=(0.0, 0.0),
                 w=1280, h=720, seed=1):
        self.pos = np.array(start, float)
        self.camera = np.array(camera, float)
        a = math.radians(angle_deg)
        rot = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
        flip = np.diag([1.0, -1.0]) if mirror else np.eye(2)  # image Y points down
        self.A = px_per_mm * rot @ flip
        self.backlash = backlash
        self.offset = np.array(tool_offset, float)
        self.last_dir = np.zeros(2)
        self.w, self.h = w, h
        self.seed = seed
        self.moves = []
        self.frame_no = 0

    # --- printer interface ---
    def position(self):
        return [float(self.pos[0]), float(self.pos[1]), 5.0]

    def homed_axes(self):
        return "xyz"

    def move_relative(self, dx, dy, feed, approach):
        self.moves.append((dx, dy))
        target = self.pos + np.array([dx, dy])
        self._go(target - approach)
        self._go(target)

    def move_absolute(self, x, y, feed, approach):
        target = np.array([x, y], float)
        self._go(target - approach)
        self._go(target)

    def _go(self, target):
        self.last_dir = np.sign(target - self.pos)
        self.pos = target

    # --- camera interface ---
    def nozzle_px(self):
        # Backlash: the real nozzle lags behind by `backlash` against the last direction.
        real = self.pos + self.offset - self.backlash * self.last_dir
        p = np.array([self.w / 2, self.h / 2]) + self.A @ (real - self.camera)
        return p

    def frame(self):
        self.frame_no += 1
        x, y = self.nozzle_px()
        return render_nozzle(x, y, self.w, self.h, seed=self.seed + self.frame_no)
