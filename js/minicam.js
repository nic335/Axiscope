// Minicam: a second camera (e.g. a chamber cam) floating in a screen corner.
// Drag the window to move it (it snaps to the nearest corner); drag the
// inner-corner handle, or use arrow keys on it, to resize.
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
    if (!this.state.stream || !cams.some(c => c.stream === this.state.stream)) {
      const other = cams.find(c => c.reachable && (!S.camera || c.stream !== S.camera.stream)) || cams[0];
      if (other && open) { this.state.stream = other.stream; this.save(); }
    }
    setHTML($('minicam-select'), cams.length
      ? cams.map(c => `<option value="${esc(c.stream)}"${c.stream === this.state.stream ? ' selected' : ''}>${esc(c.name)}${c.reachable ? '' : ' (offline)'}</option>`).join('')
      : '<option value="">Connect a printer first</option>');
    $('minicam-select').value = this.state.stream || '';
    this.load();
  },

  load() {
    const want = this.state.open && this.state.stream && S.host ? this.state.stream : null;
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
