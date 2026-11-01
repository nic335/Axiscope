// Camera viewport: fits the stream into the viewport, applies zoom / flip /
// contrast, and draws the crosshair and detection overlay in source-image
// pixels so they stay registered with the picture under every transform.
const SVG_NS = 'http://www.w3.org/2000/svg';
const ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6];

const CameraView = {
  img: null, stage: null, viewport: null, overlay: null, edgeImg: null,
  frame: null,          // {width, height} of the source image
  view: null,           // {crosshair, zoom, flipH, flipV, contrast}
  detection: null,      // last detection result {best, candidates, width, height}
  showOverlay: true,
  onFrameSize: null,
  onPick: null,         // (x, y) in source pixels when the image is clicked
  onFeedState: null,
  _probe: null,

  init(view) {
    this.view = view;
    this.img = document.getElementById('camera-img');
    this.edgeImg = document.getElementById('edge-img');
    this.stage = document.getElementById('camera-stage');
    this.viewport = document.getElementById('camera-viewport');
    this.overlay = document.getElementById('overlay');
    new ResizeObserver(() => this.fit()).observe(this.viewport);
    this.viewport.addEventListener('click', e => {
      if (!this.onPick || e.target.closest('button, a')) return;
      const pt = this.toSource(e.clientX, e.clientY);
      if (pt) this.onPick(pt[0], pt[1]);
    });
    this.img.addEventListener('error', () => {
      clearInterval(this._probe);
      this.onFeedState && this.onFeedState('error');
    });
    this.applyView();
  },

  setStream(url) {
    clearInterval(this._probe);
    this.frame = null;
    this.img.removeAttribute('src');
    this.stage.classList.remove('has-frame');
    if (!url) { this.onFeedState && this.onFeedState('none'); return; }
    this.onFeedState && this.onFeedState('connecting');
    this.img.src = url;
    // MJPEG streams do not reliably fire `load`; poll for the first frame.
    this._probe = setInterval(() => {
      if (this.img.naturalWidth > 0) {
        clearInterval(this._probe);
        this.setFrame(this.img.naturalWidth, this.img.naturalHeight);
        this.stage.classList.add('has-frame');
        this.onFeedState && this.onFeedState('live');
      }
    }, 200);
  },

  setFrame(width, height) {
    if (this.frame && this.frame.width === width && this.frame.height === height) return;
    this.frame = { width, height };
    this.setAspect();
    this.fit();
    this.draw();
    this.onFrameSize && this.onFrameSize(this.frame);
  },

  rotated() { return ((this.view.rotate || 0) % 180) !== 0; },

  // The viewport keeps the camera's landscape shape on desktop; a view
  // turned 90/270 degrees is fitted inside it (side bars) instead of making
  // the panel taller than the screen.
  setAspect() {
    if (!this.frame || window.matchMedia('(max-width:760px)').matches) return;
    const { width, height } = this.frame;
    this.viewport.style.aspectRatio = Math.max(width, height) + ' / ' + Math.min(width, height);
  },

  // Contain-fit the stage (image + overlay) inside the viewport. A 90/270
  // degree view turns the stage on its side, so fit its swapped box.
  fit() {
    const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
    const f = this.frame || { width: 4, height: 3 };
    const s = this.rotated()
      ? Math.min(vw / f.height, vh / f.width)
      : Math.min(vw / f.width, vh / f.height);
    const w = f.width * s, h = f.height * s;
    Object.assign(this.stage.style, {
      width: w + 'px', height: h + 'px',
      left: (vw - w) / 2 + 'px', top: (vh - h) / 2 + 'px',
    });
  },

  applyView() {
    const v = this.view;
    const sx = (v.flipH ? -1 : 1) * v.zoom, sy = (v.flipV ? -1 : 1) * v.zoom;
    // CSS applies the right-most transform first: flip/zoom, then rotate.
    this.stage.style.transform = `rotate(${v.rotate || 0}deg) scale(${sx}, ${sy})`;
    this.img.style.filter = `contrast(${v.contrast}%)`;
    this.setAspect();
    this.fit();
    this.draw();
  },

  setDetection(det, edgesDataUrl) {
    this.detection = det;
    if (edgesDataUrl) {
      this.edgeImg.src = edgesDataUrl;
      this.edgeImg.hidden = false;
    } else {
      this.edgeImg.hidden = true;
    }
    if (det && det.width && det.height && !this.frame) this.setFrame(det.width, det.height);
    this.draw();
  },

  // Screen point -> source-image pixel, through zoom, flip and rotation.
  toSource(clientX, clientY) {
    const f = this.frame;
    const ctm = this.overlay.getScreenCTM();
    if (!f || !ctm) return null;
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    if (pt.x < 0 || pt.y < 0 || pt.x > f.width || pt.y > f.height) return null;
    return [pt.x, pt.y];
  },

  target() {
    const f = this.frame;
    return f ? [f.width / 2, f.height / 2] : null;
  },

  draw() {
    const svg = this.overlay;
    const f = this.frame;
    svg.innerHTML = '';
    if (!f) return;
    const W = f.width, H = f.height;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const el = (name, attrs, parent = svg) => {
      const n = document.createElementNS(SVG_NS, name);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      parent.appendChild(n);
      return n;
    };
    const cx = W / 2, cy = H / 2, gap = H * 0.05;

    if (this.view.crosshair) {
      const g = el('g', { class: 'ov-crosshair' });
      el('path', { d: `M${cx} 0V${cy - gap}M${cx} ${cy + gap}V${H}M0 ${cy}H${cx - gap}M${cx + gap} ${cy}H${W}` }, g);
      el('circle', { cx, cy, r: gap, fill: 'none' }, g);
      const t = gap * 0.3;
      el('path', { d: `M${cx - t} ${cy}H${cx + t}M${cx} ${cy - t}V${cy + t}` }, g);
    }

    const det = this.detection;
    if (!this.showOverlay || !det) return;
    // Detection may come from a frame with a different size than the stream.
    const kx = det.width ? W / det.width : 1, ky = det.height ? H / det.height : 1;
    (det.candidates || []).forEach(c => {
      const r = Math.max(...c.rings.map(x => x.r));
      el('circle', { cx: c.x * kx, cy: c.y * ky, r: r * kx, class: 'ov-candidate' });
    });
    const b = det.best;
    if (!b) return;
    const g = el('g', { class: 'ov-detected' + (det.locked ? ' is-locked' : ''), id: 'detected-circle' });
    b.rings.forEach(ring => el('circle', { cx: b.x * kx, cy: b.y * ky, r: ring.r * kx }, g));
    const t = Math.max(6, H * 0.012);
    el('path', { d: `M${b.x * kx - t} ${b.y * ky}h${2 * t}M${b.x * kx} ${b.y * ky - t}v${2 * t}` }, g);
    if (Math.hypot(b.x * kx - cx, b.y * ky - cy) > 2) {
      el('line', { x1: b.x * kx, y1: b.y * ky, x2: cx, y2: cy, class: 'ov-error' });
    }
  },
};

// View rotation + horizontal flip that makes machine moves look natural on
// screen: +X to the right and +Y up. `mapping.matrix` columns are the image
// motion (px per mm, image y down) for +X and +Y machine moves.
function viewForMapping(mapping) {
  const m = mapping.matrix;
  const ax = [m[0][0], m[1][0]], ay = [m[0][1], m[1][1]];
  const nx = Math.hypot(...ax), ny = Math.hypot(...ay);
  let best = null;
  for (const rotate of [0, 90, 180, 270]) {
    for (const flipH of [false, true]) {
      const r = rotate * Math.PI / 180;
      const t = v => {
        const x = flipH ? -v[0] : v[0], y = v[1];
        return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
      };
      const score = t(ax)[0] / nx - t(ay)[1] / ny;   // +X right, +Y up (screen y down)
      if (!best || score > best.score) best = { rotate, flipH, flipV: false, score };
    }
  }
  return best;
}
