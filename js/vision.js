// OpenCV circle detection and closed-loop auto alignment (front end).
// The heavy lifting runs in the Axiscope backend (axiscope_vision/), which
// grabs camera snapshots and moves the printer through Moonraker.

const DETECTION_DEFAULTS = {
  enabled: false, overlay: true, edges: false,
  min_radius: 8, max_radius: 200, hough_votes: 30,
  canny_low: 40, canny_high: 120, blur: 5, min_coverage: 0.45,
  require_concentric: true,
};
const DETECTION_KEYS = ['min_radius', 'max_radius', 'hough_votes', 'canny_low', 'canny_high', 'blur', 'min_coverage', 'require_concentric'];

const ALIGN_DEFAULTS = {
  max_iterations: 5, tolerance: 0.01, probe_distance: 0.5, max_move: 3.0,
  settle: 0.4, samples: 3, feed: 10, approach: 0, reuse_calibration: false,
};
const ALIGN_FIELDS = [
  { key: 'max_iterations', label: 'Max corrections (N)', min: 1, max: 25, step: 1, unit: '' },
  { key: 'tolerance', label: 'Tolerance', min: 0.001, max: 0.5, step: 0.001, unit: 'mm' },
  { key: 'probe_distance', label: 'Probe move', min: 0.05, max: 3, step: 0.05, unit: 'mm' },
  { key: 'max_move', label: 'Safety limit per move', min: 0.1, max: 20, step: 0.1, unit: 'mm' },
  { key: 'settle', label: 'Settle after move', min: 0, max: 5, step: 0.05, unit: 's' },
  { key: 'samples', label: 'Frames per scan', min: 1, max: 9, step: 1, unit: '' },
  { key: 'feed', label: 'Move speed', min: 1, max: 100, step: 1, unit: 'mm/s' },
  { key: 'approach', label: 'Backlash approach', min: 0, max: 2, step: 0.05, unit: 'mm' },
];
const TERMINAL = ['converged', 'not_converged', 'failed', 'cancelled'];

const Vision = {
  settings: null,       // detection settings (persisted)
  align: null,          // auto-align settings (persisted)
  available: null,      // backend /api/status result
  last: null,           // last detection result
  job: null,            // last auto-align status
  dials: {},
  _timer: null,
  _inflight: false,
  _fails: 0,            // consecutive detection failures, for backoff
  _jobTimer: null,

  init() {
    this.settings = Object.assign({}, DETECTION_DEFAULTS, LS.get('detection', {}));
    this.align = Object.assign({}, ALIGN_DEFAULTS, LS.get('align', {}));
    this.buildDetectionControls();
    this.buildAlignSettings();
    this.bindEvents();
    this.renderSettings();
    this.checkBackend();
  },

  save() {
    LS.set('detection', this.settings);
    LS.set('align', this.align);
  },

  params() {
    const p = {};
    DETECTION_KEYS.forEach(k => { p[k] = this.settings[k]; });
    return p;
  },

  // --------------------------------------------------------------- controls
  buildDetectionControls() {
    const s = this.settings;
    const dial = (key, spec, after) => {
      this.dials[key] = buildDial(document.querySelector(`[data-dial="${key}"]`),
        Object.assign({ id: 'circle-' + key.replace(/_/g, '-'), value: key === 'min_coverage' ? Math.round(s[key] * 100) : s[key] }, spec),
        v => {
          s[key] = key === 'min_coverage' ? v / 100 : v;
          if (after) after(v);
          this.save();
          this.kick();
        });
    };
    dial('min_radius', { label: 'Min radius', min: 2, max: 400, unit: ' px' }, v => {
      if (s.max_radius <= v) { s.max_radius = v + 1; this.dials.max_radius.set(s.max_radius); }
    });
    dial('max_radius', { label: 'Max radius', min: 3, max: 600, unit: ' px' }, v => {
      if (s.min_radius >= v) { s.min_radius = v - 1; this.dials.min_radius.set(s.min_radius); }
    });
    dial('hough_votes', { label: 'Vote threshold · param2', min: 5, max: 100 });
    dial('canny_low', { label: 'Canny low', min: 5, max: 250 }, v => {
      if (s.canny_high <= v) { s.canny_high = v + 1; this.dials.canny_high.set(s.canny_high); }
    });
    dial('canny_high', { label: 'Canny high · param1', min: 10, max: 400 }, v => {
      if (s.canny_low >= v) { s.canny_low = v - 1; this.dials.canny_low.set(s.canny_low); }
    });
    dial('blur', { label: 'Blur kernel', min: 0, max: 15, format: v => (v < 3 ? 'off' : (v | 1) + ' px') });
    dial('min_coverage', { label: 'Min ring coverage', min: 10, max: 100, unit: '%' });
  },

  buildAlignSettings() {
    $('align-settings').innerHTML = ALIGN_FIELDS.map(f => `<label class="setting-field" for="set-${f.key}">
        <span>${esc(f.label)}</span>
        <span class="setting-input"><input id="set-${f.key}" type="number" min="${f.min}" max="${f.max}" step="${f.step}" data-key="${f.key}" inputmode="decimal">${f.unit ? `<small>${f.unit}</small>` : ''}</span>
      </label>`).join('');
    $('align-settings').addEventListener('change', e => {
      const f = ALIGN_FIELDS.find(x => x.key === e.target.dataset.key);
      if (!f) return;
      let v = Number(e.target.value);
      if (!Number.isFinite(v)) v = ALIGN_DEFAULTS[f.key];
      v = Math.min(f.max, Math.max(f.min, v));
      if (f.step === 1) v = Math.round(v);
      this.align[f.key] = v;
      e.target.value = v;
      this.save();
    });
    $('set-reuse').addEventListener('change', e => { this.align.reuse_calibration = e.target.checked; this.save(); });
    $('align-settings-reset').addEventListener('click', () => {
      this.align = Object.assign({}, ALIGN_DEFAULTS);
      this.save();
      this.renderSettings();
    });
  },

  renderSettings() {
    const s = this.settings;
    $('detection-enabled').checked = s.enabled;
    $('det-onoff').textContent = s.enabled ? 'On' : 'Off';
    $('detection-body').hidden = !s.enabled;
    $('circle-concentric').checked = s.require_concentric;
    $('circle-overlay').checked = s.overlay;
    $('circle-edges').checked = s.edges;
    Object.entries(this.dials).forEach(([k, d]) => d.set(k === 'min_coverage' ? Math.round(s[k] * 100) : s[k]));
    ALIGN_FIELDS.forEach(f => { $('set-' + f.key).value = this.align[f.key]; });
    $('set-reuse').checked = this.align.reuse_calibration;
    CameraView.showOverlay = s.enabled && s.overlay;
    if (!s.enabled) CameraView.setDetection(null);
    this.renderEligibility();
  },

  bindEvents() {
    const s = this.settings;
    $('detection-enabled').addEventListener('change', e => {
      s.enabled = e.target.checked;
      this.save();
      this.renderSettings();
      renderWorkflow();
      this.schedule(true);
    });
    $('circle-concentric').addEventListener('change', e => { s.require_concentric = e.target.checked; this.save(); this.kick(); });
    $('circle-overlay').addEventListener('change', e => { s.overlay = e.target.checked; this.save(); this.renderSettings(); });
    $('circle-edges').addEventListener('change', e => { s.edges = e.target.checked; this.save(); if (!s.edges) CameraView.setDetection(this.last); this.kick(); });
    $('detection-reset').addEventListener('click', () => {
      Object.assign(s, DETECTION_DEFAULTS, { enabled: true });
      this.save();
      this.renderSettings();
      this.kick();
    });
    $('auto-align').addEventListener('click', () => this.startAlign());
    $('jog-align-circle').addEventListener('click', () => this.startAlign());
    $('align-cancel').addEventListener('click', () => Api.alignCancel().catch(e => notice(e.message, 'error')));
    $('align-retry').addEventListener('click', () => this.startAlign());
    $('align-dismiss').addEventListener('click', () => { $('align-panel').hidden = true; this.job = null; this.schedule(true); });
    $('align-revert').addEventListener('click', async () => {
      $('align-revert').disabled = true;
      try {
        const r = await Api.alignRevert();
        notice(`Moved back to X ${r.position[0].toFixed(3)} Y ${r.position[1].toFixed(3)}.`);
        $('align-panel').hidden = true;
        this.job = null;
      } catch (e) {
        notice('Revert failed: ' + e.message, 'error');
      } finally {
        $('align-revert').disabled = false;
        poll();
        this.schedule(true);
      }
    });
    $('align-accept').addEventListener('click', async () => {
      const job = this.job;
      if (!job || job.tool !== activeTool()) {
        notice('The active tool changed since alignment; capture manually or run it again.', 'error');
        return;
      }
      await poll();  // make sure the captured position is the post-alignment one
      capture();
      $('align-panel').hidden = true;
      this.job = null;
      this.schedule(true);
    });
    document.addEventListener('visibilitychange', () => this.schedule(true));
  },

  // ------------------------------------------------------------- backend
  async checkBackend() {
    try {
      this.available = await Api.status();
    } catch (e) {
      this.available = { opencv: false, error: 'Axiscope backend not reachable (' + e.message + ')' };
    }
    const a = this.available;
    $('vision-status').textContent = a.opencv ? 'OpenCV ' + a.opencv_version + ' on the Axiscope host' : a.error || 'OpenCV unavailable';
    $('vision-pill').textContent = a.opencv ? 'Ready' : 'Unavailable';
    $('vision-pill').dataset.state = a.opencv ? 'ok' : 'warn';
    $('det-engine').textContent = a.opencv ? 'OPENCV ' + a.opencv_version : 'UNAVAILABLE';
    if (!a.opencv) $('det-sub').textContent = 'OpenCV is not installed on the Axiscope host. Re-run install.sh to enable detection.';
    // Resume a job that was running before a page reload.
    if (a.align && !TERMINAL.includes(a.align.state) && a.align.state !== 'idle') {
      S.busy = true;
      this.showJob(a.align);
      this.pollJob();
    }
    this.renderEligibility();
    this.schedule(true);
  },

  // ------------------------------------------------------ live detection
  shouldDetect() {
    return this.settings.enabled && this.available && this.available.opencv && S.camera && S.host
      && S.tab === 'calibration' && !S.busy && !document.hidden;
  },

  schedule(now) {
    clearTimeout(this._timer);
    if (!this.shouldDetect()) {
      if (!this.settings.enabled) CameraView.setDetection(null);
      return;
    }
    // Back off while the snapshot keeps failing (0.7 s doubling up to 15 s),
    // instead of hammering a dead camera and flooding the console with errors.
    const delay = this._fails ? Math.min(15000, 700 * 2 ** this._fails) : 700;
    this._timer = setTimeout(() => this.tick(), now ? 0 : delay);
  },

  // Settings changed: run detection again soon, but don't flood the backend.
  kick: debounce(function () { Vision.schedule(true); }, 250),

  async tick() {
    if (this._inflight || !this.shouldDetect()) return;
    this._inflight = true;
    try {
      const res = await Api.detect({ camera_url: S.camera.snapshot, params: this.params(), edges: this.settings.edges });
      this.last = res;
      this._fails = 0;
      if (this.shouldDetect()) CameraView.setDetection(res, this.settings.edges ? res.edges : null);
      this.renderDetection(res);
    } catch (e) {
      this.last = null;
      this._fails++;
      CameraView.setDetection(null);
      const wait = Math.round(Math.min(15000, 700 * 2 ** this._fails) / 1000);
      $('detection-status').textContent = 'Detection could not get a frame: ' + e.message + ` Retrying in ${wait} s.`;
    } finally {
      this._inflight = false;
      this.renderEligibility();
      this.schedule();
    }
  },

  renderDetection(res) {
    const el = $('detection-status');
    const b = res && res.best;
    if (!b) {
      el.textContent = res && res.warning ? res.warning
        : 'No concentric circles · widen the radius range or lower thresholds';
      return;
    }
    const t = CameraView.target();
    const kx = CameraView.frame && res.width ? CameraView.frame.width / res.width : 1;
    const d = t ? Math.hypot(b.x * kx - t[0], b.y * kx - t[1]) / kx : 0;
    const radii = b.rings.map(r => Math.round(r.r)).join('/');
    el.textContent = `${b.rings.length} ring${b.rings.length === 1 ? '' : 's'} · r ${radii} px · ${d.toFixed(1)} px from crosshair · ${Math.round(res.ms)} ms`;
  },

  renderEligibility() {
    const reasons = [];
    if (!this.available || !this.available.opencv) reasons.push('OpenCV is unavailable on the Axiscope host');
    if (!S.online || !S.status) reasons.push('Connect a printer');
    else if (!isHomed()) reasons.push('Home the printer first');
    else if (activeTool() < 0) reasons.push('Pick up a tool first');
    if (!S.camera) reasons.push('Select a camera');
    if (!this.settings.enabled) reasons.push('Enable circle detection');
    else if (!this.last || !this.last.best) reasons.push('No nozzle detected yet');
    if (S.busy) reasons.length = 0;
    const ok = !reasons.length && !S.busy;
    const why = S.busy ? 'Alignment running' : ok ? 'Scan, probe-move and centre the nozzle on the crosshair' : reasons[0];
    ['auto-align', 'jog-align-circle'].forEach(id => {
      $(id).disabled = !ok;
      $(id).title = why;
    });
    $('jog-align-circle').classList.toggle('detection-active', this.settings.enabled);
  },

  // ------------------------------------------------------- auto alignment
  async startAlign() {
    if (S.busy) return;
    const tool = activeTool();
    S.busy = true;
    renderBusy();
    clearTimeout(this._timer);
    try {
      const job = await Api.alignStart({
        printer: S.host,
        camera_url: S.camera.snapshot,
        params: this.params(),
        settings: this.align,
        target: CameraView.target(),
        tool,
      });
      this.showJob(job);
      this.pollJob();
    } catch (e) {
      S.busy = false;
      notice('Auto alignment could not start: ' + e.message, 'error');
      renderBusy();
      this.schedule(true);
    }
  },

  pollJob() {
    clearTimeout(this._jobTimer);
    this._jobTimer = setTimeout(async () => {
      let job;
      try { job = await Api.alignStatus(); } catch (e) { this.pollJob(); return; }
      this.showJob(job);
      if (TERMINAL.includes(job.state) || job.state === 'idle') {
        S.busy = false;
        poll();
        renderBusy();
        this.schedule(true);
      } else {
        this.pollJob();
      }
    }, 400);
  },

  showJob(job) {
    this.job = job;
    $('align-panel').hidden = false;
    const labels = { running: 'RUNNING', converged: 'CENTERED', not_converged: 'NOT WITHIN TOLERANCE', failed: 'FAILED', cancelled: 'CANCELLED', idle: 'IDLE' };
    $('align-state').textContent = labels[job.state] || job.state.toUpperCase();
    $('align-panel').dataset.state = job.state;
    $('align-cancel').hidden = job.state !== 'running';
    $('align-steps').innerHTML = (job.steps || []).map(s => `<li data-phase="${esc(s.phase)}"><span>${esc(s.phase.replace('_', ' '))}</span>${esc(s.message)}</li>`).join('');
    $('align-steps').scrollTop = $('align-steps').scrollHeight;
    if (job.detection && job.frame) {
      CameraView.setDetection(Object.assign({ best: job.detection, candidates: [] }, job.frame));
    }
    const done = TERMINAL.includes(job.state);
    $('align-result').hidden = !done;
    if (!done) return;
    const r = job.result;
    const metric = (label, value) => `<div><span>${label}</span><b>${value}</b></div>`;
    $('align-metrics').innerHTML = r ? [
      metric('RESIDUAL', r.error_mm.toFixed(4) + '<small>mm</small>'),
      metric('CORRECTIONS', r.corrections + ' / ' + this.align.max_iterations),
      metric('SCALE', r.mapping.px_per_mm.toFixed(0) + '<small>px/mm</small>'),
      metric('MOVED', `${signed(r.moved_mm[0])} / ${signed(r.moved_mm[1])}`),
    ].join('') : '';
    const canAccept = !!r && job.tool === activeTool();
    const v = $('align-verdict');
    if (job.state === 'converged') {
      v.textContent = `T${job.tool} is centred within ${r.tolerance} mm. Check the camera view, then accept to capture this position.`;
    } else if (job.state === 'not_converged') {
      v.textContent = `Stopped after ${r.corrections} corrections, ${r.error_mm.toFixed(4)} mm from the crosshair (tolerance ${r.tolerance} mm). You can still accept, nudge it manually, or run again.`;
    } else if (job.state === 'failed') {
      v.textContent = job.message;
    } else {
      v.textContent = 'Cancelled. The toolhead stays where it stopped.';
    }
    $('align-accept').hidden = !r;
    $('align-accept').disabled = !canAccept;
    $('align-accept-label').textContent = job.tool === 0 ? 'Accept & capture reference' : `Accept & capture T${job.tool}`;
    $('align-revert').hidden = !job.start_position;
  },

  // A different camera gets a fresh start.
  resetBackoff() {
    this._fails = 0;
    this.schedule(true);
  },

  stopAll() {
    clearTimeout(this._timer);
    this._fails = 0;
    this.last = null;
    CameraView.setDetection(null);
  },
};
