"""
Auto-tuning of the detection settings.

1. Find the target nozzle:
   - a position the user locked (clicked), or
   - motion: frames before and after a small X move; circles that moved are
     on the toolhead, circles that stayed put (screws, reflections) are not, or
   - consensus: the circle found most consistently across frames.
2. Radius range from the target's rings (a margin below the smallest and
   above the largest).
3. Search blur / Canny / ring coverage on several frames and keep the setting
   that finds the target most reliably, with the steadiest centre and the
   cleanest edge map.
"""
import math
import time

import cv2
import numpy as np

from .detect import detect, merge_params

GRID_BLUR = (3, 5, 7, 9)
GRID_CANNY_HIGH = (60, 90, 120, 160, 200, 260)
CANNY_LOW_RATIO = 0.4
GRID_COVERAGE = (0.35, 0.45, 0.55)


class TuneError(RuntimeError):
    pass


def _change_map(a, b):
    ga = cv2.GaussianBlur(cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), (0, 0), 2).astype(np.float32)
    gb = cv2.GaussianBlur(cv2.cvtColor(b, cv2.COLOR_BGR2GRAY), (0, 0), 2).astype(np.float32)
    return np.abs(ga - gb)


def _mean_in_disk(img, x, y, r):
    h, w = img.shape[:2]
    x0, x1 = max(0, int(x - r)), min(w, int(x + r) + 1)
    y0, y1 = max(0, int(y - r)), min(h, int(y + r) + 1)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    yy, xx = np.mgrid[y0:y1, x0:x1]
    inside = (xx - x) ** 2 + (yy - y) ** 2 <= r * r
    return float(img[y0:y1, x0:x1][inside].mean()) if inside.any() else 0.0


def _circles(res):
    out = [res["best"]] if res["best"] else []
    return out + [c for c in res["candidates"] if c.get("concentric")]


# Edge settings for *finding* the nozzle. Independent of the user's current
# settings, which are what autotune is fixing and may be unusable.
PROBE_EDGES = ((5, 120), (7, 90), (9, 60), (3, 200), (7, 200), (9, 260))   # (blur, canny_high)


def _broad_variants(base, shape):
    h, w = shape[:2]
    for blur, high in PROBE_EDGES:
        yield dict(base, min_radius=4, max_radius=int(min(h, w) * 0.45), require_concentric=False,
                   blur=blur, canny_high=high, canny_low=int(round(high * CANNY_LOW_RATIO)))


def find_target(frames, base, lock=None, moved_frames=None):
    """Return (target circle, how it was identified), trying several edge
    settings until one of them identifies the nozzle."""
    last = None
    for broad in _broad_variants(base, frames[0].shape):
        try:
            return _find_target(frames, broad, lock, moved_frames)
        except TuneError as e:
            last = e
    raise last


def _find_target(frames, broad, lock, moved_frames):
    if lock and lock.get("x") is not None:
        h = frames[0].shape[0]
        lk = {"x": lock["x"], "y": lock["y"], "radius": max(40.0, 0.08 * h),
              "rings": lock.get("rings") or []}
        res = detect(frames[0], broad, lock=lk)
        if not res.get("locked"):
            raise TuneError("No circle found where the nozzle was clicked. Click the nozzle's centre.")
        return res["best"], "locked target"

    if moved_frames:
        # What changed between the frame before and after the move? The
        # nozzle's area changes a lot; static circles only by sensor noise.
        diff = _change_map(frames[0], moved_frames[0])
        noise = float(np.median(diff)) + 1.0
        movers, static = [], 0
        for a in _circles(detect(frames[0], broad)):
            ratio = _mean_in_disk(diff, a["x"], a["y"], max(r["r"] for r in a["rings"])) / noise
            if ratio >= 4.0:
                movers.append((ratio, a))
            elif ratio < 2.0:
                static += 1
        if movers:
            best = max(movers, key=lambda m: (len(m[1]["rings"]), m[0]))[1]
            note = "moved with the toolhead"
            if static:
                note += "; ignored %d circle(s) that stayed put" % static
            return best, note
        # Fall through to consensus when nothing could be matched across the move.

    found = [r["best"] for r in (detect(f, broad) for f in frames) if r["best"]]
    if not found:
        raise TuneError("No circles found at all. Is the nozzle in view and lit?")
    clusters = []
    for c in found:
        for cl in clusters:
            if math.hypot(cl[0]["x"] - c["x"], cl[0]["y"] - c["y"]) < max(5.0, 0.1 * max(r["r"] for r in c["rings"])):
                cl.append(c)
                break
        else:
            clusters.append([c])
    cl = max(clusters, key=len)
    if len(cl) < max(2, len(frames) // 2 + 1):
        raise TuneError("Detection is not consistent between frames. Click the nozzle "
                        "to lock it, or home the printer so autotune can move to find it.")
    return max(cl, key=lambda c: len(c["rings"])), "found most consistently"


def _evaluate(frames, params, target, tol):
    """Score one setting on all frames. Higher is better."""
    rings_t = [r["r"] for r in target["rings"]]
    lock = {"x": target["x"], "y": target["y"], "radius": 3 * tol, "rings": rings_t}
    hits, own, pts, rings, density, ms = 0, 0, [], [], [], []
    for f in frames:
        free = detect(f, params)                  # without help: is the nozzle the top circle?
        res = detect(f, params, lock=lock)        # with the lock, as the live view runs
        b = res["best"]
        ms.append(free["ms"] + res["ms"])
        h, w = f.shape[:2]
        sc = free.get("scale", 1.0) or 1.0
        density.append(free["edge_pixels"] / float(w * h * sc * sc))
        fb = free["best"]
        if fb and math.hypot(fb["x"] - target["x"], fb["y"] - target["y"]) <= tol:
            own += 1
        if res.get("locked") and b and math.hypot(b["x"] - target["x"], b["y"] - target["y"]) <= tol:
            hits += 1
            pts.append((b["x"], b["y"]))
            rings.append(len(b["rings"]))
    n = float(len(frames))
    jitter = float(np.max(np.hypot(*(np.array(pts) - np.median(pts, axis=0)).T))) if len(pts) > 1 else (0.0 if pts else 99.0)
    score = (10.0 * hits / n + 3.0 * own / n - 0.5 * min(jitter, 10.0)
             - 20.0 * float(np.mean(density)) + 0.5 * min(float(np.mean(rings)) if rings else 0.0, 3.0)
             - 0.002 * float(np.mean(ms)))
    return {"score": round(score, 3), "found": hits, "found_unaided": own, "frames": len(frames),
            "jitter_px": round(jitter, 2), "edge_density": round(float(np.mean(density)), 4),
            "rings": round(float(np.mean(rings)), 1) if rings else 0.0, "ms": round(float(np.mean(ms)), 1)}


def autotune(frames, base_params=None, lock=None, moved_frames=None):
    t0 = time.time()
    base = merge_params(base_params)
    target, how = find_target(frames, base, lock, moved_frames)
    radii = [r["r"] for r in target["rings"]]
    tuned = dict(base)
    tuned["min_radius"] = max(3, int(math.floor(0.75 * min(radii))))
    tuned["max_radius"] = max(tuned["min_radius"] + 2, int(math.ceil(1.2 * max(radii))))
    tuned["require_concentric"] = len(radii) >= 2
    tol = max(4.0, 0.15 * min(radii))

    tried = []

    def run(p):
        r = _evaluate(frames, p, target, tol)
        tried.append((r, p))
        return r

    # Pass 1: blur x Canny; pass 2: ring coverage on the winner.
    best_r, best_p = None, None
    for blur in GRID_BLUR:
        for high in GRID_CANNY_HIGH:
            p = dict(tuned, blur=blur, canny_high=high, canny_low=int(round(high * CANNY_LOW_RATIO)))
            r = run(p)
            if best_r is None or r["score"] > best_r["score"]:
                best_r, best_p = r, p
    for cov in GRID_COVERAGE:
        if cov == best_p["min_coverage"]:
            continue
        p = dict(best_p, min_coverage=cov)
        r = run(p)
        if r["score"] > best_r["score"]:
            best_r, best_p = r, p

    if best_r["found"] == 0:
        raise TuneError("No setting found the nozzle reliably. Check focus and lighting.")
    keys = ("min_radius", "max_radius", "blur", "canny_low", "canny_high", "min_coverage", "require_concentric")
    tried.sort(key=lambda t: t[0]["score"], reverse=True)
    return {
        "params": {k: best_p[k] for k in keys},
        "quality": best_r,
        "target": {"x": round(target["x"], 2), "y": round(target["y"], 2), "rings": radii, "how": how},
        "alternatives": [dict(t[0], params={k: t[1][k] for k in ("blur", "canny_low", "canny_high", "min_coverage")})
                         for t in tried[1:5]],
        "settings_tried": len(tried),
        "seconds": round(time.time() - t0, 1),
    }
