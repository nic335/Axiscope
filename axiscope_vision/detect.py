"""
Nozzle detection: edge detection followed by a search for concentric circles.

Pipeline
--------
1. Grayscale -> optional CLAHE -> Gaussian blur.
2. Canny edge map.
3. Candidate centres from HoughCircles, from circle fits of edge contours,
   from the image centre and from an optional tracking hint.
4. For each candidate, build a radial edge-coverage profile: for every
   radius, the fraction of angular sectors that contain an edge pixel at
   that distance. Peaks in the profile are rings.
5. Refine the centre with a joint least-squares fit of all rings sharing
   one centre (concentric fit), then re-measure the profile. Repeat.
6. The candidate with the best ring score wins. A nozzle normally shows at
   least two rings (orifice + tip face), so concentricity is required by
   default.

All coordinates are source-image pixels.
"""
import math
import time

import cv2
import numpy as np

DEFAULTS = {
    "min_radius": 8,          # px
    "max_radius": 200,        # px
    "canny_low": 40,
    "canny_high": 120,        # also Hough param1
    "hough_votes": 30,        # Hough param2 (accumulator threshold)
    "blur": 5,                # Gaussian kernel, 0/1 disables
    "clahe": True,
    "min_coverage": 0.45,     # fraction of the circumference with edges
    "min_prominence": 0.25,   # ring coverage above the profile median
    "min_ring_gap": 3.0,      # px between distinct rings
    "max_rings": 5,
    "require_concentric": True,
    "process_width": 960,     # detect on a copy scaled to this width (0 = full size)
}

_NUMERIC = {
    "min_radius": (int, 2, 2000),
    "max_radius": (int, 3, 2000),
    "canny_low": (int, 1, 1000),
    "canny_high": (int, 2, 1000),
    "hough_votes": (int, 1, 500),
    "blur": (int, 0, 31),
    "min_coverage": (float, 0.05, 1.0),
    "min_prominence": (float, 0.0, 1.0),
    "min_ring_gap": (float, 1.0, 100.0),
    "max_rings": (int, 1, 12),
    "process_width": (int, 0, 8000),
}
_BOOL = ("clahe", "require_concentric")

ANGLE_BINS = 72           # 5 degree sectors
RADIAL_TOLERANCE = 1      # +-px when deciding a sector is covered at radius r
REFINE_ITERATIONS = 3
MAX_EDGE_DENSITY = 0.12   # fraction of pixels that are edges


def merge_params(user=None):
    """Return DEFAULTS overridden by validated, clamped user values."""
    params = dict(DEFAULTS)
    for key, value in (user or {}).items():
        if key in _NUMERIC:
            cast, lo, hi = _NUMERIC[key]
            try:
                params[key] = min(hi, max(lo, cast(value)))
            except (TypeError, ValueError):
                pass
        elif key in _BOOL:
            params[key] = bool(value)
    if params["max_radius"] <= params["min_radius"]:
        params["max_radius"] = params["min_radius"] + 1
    if params["canny_high"] <= params["canny_low"]:
        params["canny_high"] = params["canny_low"] + 1
    return params


def decode_image(data):
    """Decode JPEG/PNG bytes into a BGR image, or None."""
    buf = np.frombuffer(data, dtype=np.uint8)
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def preprocess(img, params):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    if params["clahe"]:
        gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    k = int(params["blur"])
    if k >= 3:
        k |= 1
        gray = cv2.GaussianBlur(gray, (k, k), 0)
    return gray


def _contour_candidates(edges, params, limit=12):
    """Algebraic (Kasa) circle fits of long, round edge contours."""
    found = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    contours = found[-2]  # OpenCV 3 returns 3 values, OpenCV 4 returns 2
    min_len = max(12, int(math.pi * params["min_radius"] * 0.5))
    contours = sorted((c for c in contours if len(c) >= min_len), key=len, reverse=True)
    out = []
    for c in contours[: limit * 4]:
        pts = c.reshape(-1, 2).astype(np.float64)
        x, y = pts[:, 0], pts[:, 1]
        a = np.column_stack([x, y, np.ones_like(x)])
        b = x * x + y * y
        try:
            sol, *_ = np.linalg.lstsq(a, b, rcond=None)
        except np.linalg.LinAlgError:
            continue
        cx, cy = sol[0] / 2.0, sol[1] / 2.0
        r2 = sol[2] + cx * cx + cy * cy
        if r2 <= 0:
            continue
        r = math.sqrt(r2)
        if not params["min_radius"] <= r <= params["max_radius"]:
            continue
        resid = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r
        if np.sqrt(np.mean(resid ** 2)) > max(1.5, 0.08 * r):
            continue
        out.append((cx, cy))
        if len(out) >= limit:
            break
    return out


def _hough_candidates(gray, params, limit=10):
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=max(4, params["min_radius"]),
        param1=params["canny_high"],
        param2=params["hough_votes"],
        minRadius=params["min_radius"],
        maxRadius=params["max_radius"],
    )
    if circles is None:
        return []
    return [(float(c[0]), float(c[1])) for c in circles[0][:limit]]


class _EdgeIndex:
    """Edge pixel coordinates for fast radial queries."""

    def __init__(self, edges):
        ys, xs = np.nonzero(edges)
        self.x = xs.astype(np.float64)
        self.y = ys.astype(np.float64)

    def around(self, cx, cy, rmax):
        m = (np.abs(self.x - cx) <= rmax) & (np.abs(self.y - cy) <= rmax)
        return self.x[m], self.y[m]


def _profile(ex, ey, cx, cy, params):
    """Radial coverage profile around (cx, cy). Returns (radii, coverage, d)."""
    rmin, rmax = params["min_radius"], params["max_radius"]
    dx, dy = ex - cx, ey - cy
    d = np.hypot(dx, dy)
    sel = (d >= rmin - RADIAL_TOLERANCE) & (d <= rmax + RADIAL_TOLERANCE)
    radii = np.arange(rmin, rmax + 1)
    if not np.any(sel):
        return radii, np.zeros(len(radii)), d
    ri = np.rint(d[sel]).astype(np.int64) - rmin
    ang = np.arctan2(dy[sel], dx[sel])
    ai = ((ang + math.pi) / (2 * math.pi) * ANGLE_BINS).astype(np.int64) % ANGLE_BINS
    occ = np.zeros((len(radii) + 2 * RADIAL_TOLERANCE, ANGLE_BINS), dtype=bool)
    occ[ri + RADIAL_TOLERANCE, ai] = True
    # A sector counts at radius r if covered at r +- tolerance.
    acc = np.zeros((len(radii), ANGLE_BINS), dtype=bool)
    for off in range(2 * RADIAL_TOLERANCE + 1):
        acc |= occ[off: off + len(radii)]
    return radii, acc.mean(axis=1), d


def _peaks(radii, cov, threshold, prominence, gap, limit):
    """Non-maximum suppressed peaks of the coverage profile.

    A ring must cover `threshold` of its circumference and stand
    `prominence` above the profile median, so uniformly dense edges
    (noise, texture) do not register as rings. Returns (r, prominence).
    """
    base = float(np.median(cov))
    strength = cov - base
    order = np.argsort(strength)[::-1]
    picked = []
    for i in order:
        if strength[i] < prominence or len(picked) >= limit:
            break
        if cov[i] < threshold:
            continue
        r = float(radii[i])
        if all(abs(r - p[0]) >= gap for p in picked):
            picked.append((r, float(strength[i])))
    return sorted(picked)


def _concentric_fit(ex, ey, cx, cy, rings, d):
    """Gauss-Newton fit of one shared centre plus one radius per ring.

    Only strong rings take part (weak partial arcs, e.g. hex flats, bias the
    centre) and edge pixels far from their ring are trimmed as outliers.
    """
    top = max(s for _, s in rings)
    groups = []
    for r, s in rings:
        if s < 0.6 * top:
            continue
        m = np.abs(d - r) <= 1.5
        if np.count_nonzero(m) >= 8:
            groups.append((ex[m], ey[m], r))
    if not groups:
        return cx, cy, None
    k = len(groups)
    x = np.concatenate([g[0] for g in groups])
    y = np.concatenate([g[1] for g in groups])
    ring_id = np.concatenate([np.full(len(g[0]), i) for i, g in enumerate(groups)])
    radii = np.array([g[2] for g in groups], dtype=np.float64)
    keep = np.ones(len(x), dtype=bool)
    for it in range(6):
        xs, ys, ids = x[keep], y[keep], ring_id[keep]
        if len(xs) < 3 + k:
            break
        dx, dy = xs - cx, ys - cy
        dist = np.hypot(dx, dy)
        dist[dist == 0] = 1e-9
        res = dist - radii[ids]
        jac = np.zeros((len(xs), 2 + k))
        jac[:, 0] = -dx / dist
        jac[:, 1] = -dy / dist
        jac[np.arange(len(xs)), 2 + ids] = -1.0
        step, *_ = np.linalg.lstsq(jac, -res, rcond=None)
        cx += step[0]
        cy += step[1]
        radii += step[2:]
        if it >= 1:
            # Trim outliers against the current fit.
            full = np.hypot(x - cx, y - cy) - radii[ring_id]
            sigma = max(0.35, 1.4826 * float(np.median(np.abs(full[keep]))))
            keep = np.abs(full) <= 2.5 * sigma
        if it >= 2 and abs(step[0]) + abs(step[1]) < 1e-3:
            break
    dist = np.hypot(x[keep] - cx, y[keep] - cy)
    rms = float(np.sqrt(np.mean((dist - radii[ring_id[keep]]) ** 2))) if np.any(keep) else None
    return cx, cy, rms


def _evaluate(index, cx, cy, params):
    """Refine one candidate. Returns a result dict or None."""
    rmax = params["max_radius"] + 2
    ex, ey = index.around(cx, cy, rmax)
    if len(ex) < 16:
        return None
    rms = None
    for i in range(REFINE_ITERATIONS + 1):
        radii, cov, d = _profile(ex, ey, cx, cy, params)
        # Use softer thresholds while the centre is still being refined.
        soft = 0.6 if i < REFINE_ITERATIONS else 1.0
        rings = _peaks(radii, cov, params["min_coverage"] * soft,
                       params["min_prominence"] * soft,
                       params["min_ring_gap"], params["max_rings"])
        if not rings:
            return None
        if i == REFINE_ITERATIONS:
            break
        ncx, ncy, rms = _concentric_fit(ex, ey, cx, cy, rings, d)
        if math.hypot(ncx - cx, ncy - cy) > params["max_radius"]:
            return None
        cx, cy = ncx, ncy
        ex, ey = index.around(cx, cy, rmax)
    score = sum(c for _, c in rings[: params["max_rings"]])
    return {
        "x": float(cx),
        "y": float(cy),
        "rings": [{"r": round(r, 2), "strength": round(c, 3)} for r, c in rings],
        "score": round(float(score), 3),
        "fit_rms": None if rms is None else round(rms, 3),
    }


def detect(img, params=None, hint=None, want_edges=False):
    """
    Find the nozzle in a BGR image.

    hint: optional (x, y) where the nozzle is expected; it becomes a
          candidate and breaks ties between similar candidates.

    Returns a dict with image size, the best detection (or None), the other
    candidates and timing information.
    """
    t0 = time.perf_counter()
    p = merge_params(params)
    H, W = img.shape[:2]
    # Large frames (1080p+) are slow to search; work on a scaled copy and map
    # the result back. The ring fit is sub-pixel, so accuracy stays well
    # under a source pixel at 2x reduction.
    scale = 1.0
    if p["process_width"] and W > p["process_width"]:
        scale = p["process_width"] / float(W)
        img = cv2.resize(img, (int(round(W * scale)), int(round(H * scale))), interpolation=cv2.INTER_AREA)
        if hint is not None:
            hint = ((hint[0] + 0.5) * scale - 0.5, (hint[1] + 0.5) * scale - 0.5)
    q = dict(p)
    q["min_radius"] = max(2, int(round(p["min_radius"] * scale)))
    q["max_radius"] = max(q["min_radius"] + 1, int(round(p["max_radius"] * scale)))
    q["min_ring_gap"] = max(1.5, p["min_ring_gap"] * scale)
    out = _detect_scaled(img, q, hint, want_edges)
    for r in ([out["best"]] if out["best"] else []) + out["candidates"]:
        # INTER_AREA maps source pixel centre x to (x + 0.5) * scale - 0.5.
        r["x"] = (r["x"] + 0.5) / scale - 0.5
        r["y"] = (r["y"] + 0.5) / scale - 0.5
        for ring in r["rings"]:
            ring["r"] = round(ring["r"] / scale, 2)
        if r["fit_rms"] is not None:
            r["fit_rms"] = round(r["fit_rms"] / scale, 3)
    out.update(width=int(W), height=int(H), params=p, scale=round(scale, 4),
               ms=round((time.perf_counter() - t0) * 1000.0, 1))
    return out


def _detect_scaled(img, p, hint, want_edges):
    h, w = img.shape[:2]
    gray = preprocess(img, p)
    edges = cv2.Canny(gray, p["canny_low"], p["canny_high"], L2gradient=True)

    index = _EdgeIndex(edges)
    density = len(index.x) / float(w * h)
    warning = None
    seeds = []
    if hint is not None:
        seeds.append((float(hint[0]), float(hint[1])))
    if density > MAX_EDGE_DENSITY:
        # Hough on a saturated edge map is slow and meaningless.
        warning = "Edge map is %.0f%% filled; raise blur or Canny thresholds." % (density * 100)
    else:
        seeds += _hough_candidates(gray, p)
        seeds += _contour_candidates(edges, p)
    seeds.append((w / 2.0, h / 2.0))

    results = []
    for sx, sy in seeds:
        if any(math.hypot(sx - r["x"], sy - r["y"]) < 2.0 for r in results):
            continue
        res = _evaluate(index, sx, sy, p)
        if res is None:
            continue
        if any(math.hypot(res["x"] - r["x"], res["y"] - r["y"]) < 2.0 for r in results):
            continue
        results.append(res)

    for r in results:
        r["concentric"] = len(r["rings"]) >= 2
        rank = r["score"] + (0.5 if r["concentric"] else 0.0)
        if hint is not None:
            # Mild preference for the tracked position.
            rank -= 0.002 * math.hypot(r["x"] - hint[0], r["y"] - hint[1])
        r["rank"] = rank
    results.sort(key=lambda r: r["rank"], reverse=True)

    eligible = [r for r in results if r["concentric"] or not p["require_concentric"]]
    best = eligible[0] if eligible else None

    out = {
        "width": int(w),
        "height": int(h),
        "best": best,
        "candidates": [r for r in results if r is not best][:6],
        "edge_pixels": int(len(index.x)),
        "warning": warning,
    }
    if want_edges:
        ok, jpg = cv2.imencode(".jpg", edges, [cv2.IMWRITE_JPEG_QUALITY, 70])
        out["edges_jpeg"] = jpg.tobytes() if ok else None
    return out
