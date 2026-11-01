// Minicam: a second camera (e.g. a chamber cam) floating in a screen corner.
// Drag the window to move it (it snaps to the nearest corner); drag the
// inner-corner handle, or use arrow keys on it, to resize.
// Pipeline stages rendered by the backend from the alignment camera.
const VISION_STAGES = [
  ['gray', 'Grayscale'],
  ['contrast', 'Contrast boost (CLAHE)'],
  ['blur', 'Blurred (input to edges)'],
  ['edges', 'Edges (Canny)'],
  ['detection', 'Detection (rings drawn)'],
];

const Minicam = {
  state: null,   // {open, stream, corner, width}
  el: null, img: null,

  init() {
    this.state = Object.assign({ open: false, stream: null, corner: 'br', width: 320 }, LS.get('minicam', {}));
    this.el = $('minicam');
    this.img = $('minicam-img');
    $('minicam-toggle').addEventListener('click', () => this.toggle());
    $('minicam-close').addEventListener('click', () => this.toggle(false));
    $('minicam-select').addEventListener('change', e => { this.state.stream = e.target.value || null; this.save(); this.load(); });
    this.img.addEventListener('error', () => { $('minicam-empty').textContent = 'Stream unavailable'; $('minicam-empty').hidden = false; });
    this.img.addEventListener('load', () => { $('minicam-empty').hidden = true; });
    this.bindDrag();
    this.bindResize();
    window.addEventListener('resize', () => this.applyLayout());
    this.applyLayout();
    this.render();
  },

  save() { LS.set('minicam', this.state); },

  toggle(open = !this.state.open) {
    this.state.open = open;
    this.save();
    this.render();
  },

  // Called when the camera list changes.
  refresh() { this.render(); },

  render() {
    const open = this.state.open;
    this.el.hidden = !open;
    $('minicam-toggle').setAttribute('aria-pressed', open);
    const cams = S.cameras || [];
    // Default to a camera other than the alignment camera.
    const isVision = (this.state.stream || '').startsWith('vision:');
    if (!this.state.stream || (!isVision && !cams.some(c => c.stream === this.state.stream))) {
      const other = cams.find(c => c.reachable && (!S.camera || c.stream !== S.camera.stream)) || cams[0];
      if (other && open) { this.state.stream = other.stream; this.save(); }
    }
    const camOpts = cams.map(c => `<option value="${esc(c.stream)}">${esc(c.name)}${c.reachable ? '' : ' (offline)'}</option>`).join('');
    // The pipeline views need OpenCV and an alignment camera to process.
    const visionOk = S.camera && Vision.available && Vision.available.opencv
      && !(Vision.missing || []).includes('vision_frame');
    const visOpts = visionOk
      ? `<optgroup label="Vision pipeline · ${esc(S.camera.name)}">${VISION_STAGES.map(([k, l]) => `<option value="vision:${k}">${l}</option>`).join('')}</optgroup>`
      : '';
    setHTML($('minicam-select'), cams.length || visOpts
      ? (cams.length ? `<optgroup label="Cameras">${camOpts}</optgroup>` : '') + visOpts
      : '<option value="">Connect a printer first</option>');
    $('minicam-select').value = this.state.stream || '';
    this.load();
  },

  load() {
    const want = this.state.open && this.state.stream && S.host ? this.state.stream : null;
    if (want && want.startsWith('vision:')) {
      this.img.removeAttribute('src');   // drop any MJPEG connection
      this.startVision(want.slice(7));
      return;
    }
    this.stopVision();
    // Closing drops the MJPEG connection instead of streaming in the background.
    if (!want) {
      if (this.img.getAttribute('src')) this.img.removeAttribute('src');
      $('minicam-empty').textContent = (S.cameras || []).length ? 'No camera selected' : 'No camera';
      $('minicam-empty').hidden = false;
      return;
    }
    if (this.img.getAttribute('src') !== want) {
      $('minicam-empty').textContent = 'Connecting…';
      $('minicam-empty').hidden = false;
      this.img.src = want;
    }
    // MJPEG may not fire `load`; treat the first decoded frame as live.
    clearInterval(this._probe);
    this._probe = setInterval(() => {
      if (this.img.naturalWidth > 0) { $('minicam-empty').hidden = true; clearInterval(this._probe); }
    }, 250);
  },

  // Pipeline views are single processed frames from the backend; poll them
  // one at a time (never more than one request in flight).
  startVision(stage) {
    this._visionStage = stage;
    if (this._visionLoop) return;
    $('minicam-empty').textContent = 'Processing…';
    $('minicam-empty').hidden = false;
    const tick = async () => {
      if (!this._visionStage || !this.state.open || !S.camera) { this._visionLoop = null; return; }
      let wait = 250;
      if (!document.hidden) {
        try {
          const res = await fetch('/api/vision/frame', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
            body: JSON.stringify({ camera_url: S.camera.snapshot, stage: this._visionStage, params: Vision.params(), lock: Vision.lock, roi: Vision.roi(),
              view: { rotate: S.view.rotate || 0, flipH: !!S.view.flipH, flipV: !!S.view.flipV } }),
          });
          if (res.status === 404 || res.status === 405) throw new Error('the Axiscope service is older than this page. ' + RESTART_HINT);
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
          const url = URL.createObjectURL(await res.blob());
          const old = this._visionUrl;
          this._visionUrl = url;
          this.img.src = url;
          if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
          $('minicam-empty').hidden = true;
        } catch (e) {
          $('minicam-empty').textContent = 'Vision view unavailable: ' + e.message;
          $('minicam-empty').hidden = false;
          wait = 3000;
        }
      } else {
        wait = 1000;
      }
      this._visionLoop = setTimeout(tick, wait);
    };
    this._visionLoop = setTimeout(tick, 0);
  },

  stopVision() {
    this._visionStage = null;
    clearTimeout(this._visionLoop);
    this._visionLoop = null;
    if (this._visionUrl) { URL.revokeObjectURL(this._visionUrl); this._visionUrl = null; }
  },

  applyLayout() {
    const max = Math.max(180, Math.min(window.innerWidth - 32, window.innerWidth * 0.7));
    this.state.width = Math.round(Math.min(max, Math.max(160, this.state.width)));
    this.el.style.width = this.state.width + 'px';
    this.el.dataset.corner = this.state.corner;
  },

  bindDrag() {
    // Drag from anywhere (header or video) except the controls.
    const head = this.el;
    head.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('select, button, .minicam-resize')) return;
      e.preventDefault();
      head.setPointerCapture(e.pointerId);
      const r = this.el.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      this.el.classList.add('dragging');
      const move = ev => {
        this.el.style.left = ev.clientX - dx + 'px';
        this.el.style.top = ev.clientY - dy + 'px';
      };
      const up = ev => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        this.el.classList.remove('dragging');
        this.el.style.left = this.el.style.top = '';
        // Snap to the corner nearest the pointer.
        const right = ev.clientX > window.innerWidth / 2, bottom = ev.clientY > window.innerHeight / 2;
        this.state.corner = (bottom ? 'b' : 't') + (right ? 'r' : 'l');
        this.save();
        this.applyLayout();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  },

  bindResize() {
    const h = $('minicam-resize');
    // The handle sits on the corner facing the screen centre, so dragging
    // towards the centre makes the window bigger.
    const sign = () => (this.state.corner.endsWith('r') ? -1 : 1);
    h.addEventListener('pointerdown', e => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = this.state.width;
      const move = ev => { this.state.width = w0 + (ev.clientX - x0) * sign(); this.applyLayout(); };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        this.save();
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
    h.addEventListener('keydown', e => {
      const step = e.shiftKey ? 60 : 20;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') this.state.width -= step;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') this.state.width += step;
      else return;
      e.preventDefault();
      this.applyLayout();
      this.save();
    });
  },
};

document.addEventListener('DOMContentLoaded', () => Minicam.init());
