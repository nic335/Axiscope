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
    if (!window.matchMedia('(max-width:760px)').matches) {
      this.viewport.style.aspectRatio = width + ' / ' + height;
    }
    this.fit();
    this.draw();
    this.onFrameSize && this.onFrameSize(this.frame);
  },

  // Contain-fit the stage (image + overlay) inside the viewport.
  fit() {
    const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
    const f = this.frame || { width: 4, height: 3 };
    const s = Math.min(vw / f.width, vh / f.height);
    const w = f.width * s, h = f.height * s;
    Object.assign(this.stage.style, {
      width: w + 'px', height: h + 'px',
      left: (vw - w) / 2 + 'px', top: (vh - h) / 2 + 'px',
    });
  },

  applyView() {
    const v = this.view;
    const sx = (v.flipH ? -1 : 1) * v.zoom, sy = (v.flipV ? -1 : 1) * v.zoom;
    this.stage.style.transform = `scale(${sx}, ${sy})`;
    this.img.style.filter = `contrast(${v.contrast}%)`;
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
    const g = el('g', { class: 'ov-detected', id: 'detected-circle' });
    b.rings.forEach(ring => el('circle', { cx: b.x * kx, cy: b.y * ky, r: ring.r * kx }, g));
    const t = Math.max(6, H * 0.012);
    el('path', { d: `M${b.x * kx - t} ${b.y * ky}h${2 * t}M${b.x * kx} ${b.y * ky - t}v${2 * t}` }, g);
    if (Math.hypot(b.x * kx - cx, b.y * ky - cy) > 2) {
      el('line', { x1: b.x * kx, y1: b.y * ky, x2: cx, y2: cy, class: 'ov-error' });
    }
  },
};
