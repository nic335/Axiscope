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
  settle: 0.4, samples: 3, feed: 10, approach: 0, reuse_calibration: true,
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
// Backend features this page uses (see API_FEATURES in app.py).
const NEEDED_FEATURES = ['detect', 'align', 'orient', 'lock', 'mapping', 'vision_frame'];
const RESTART_HINT = 'Restart the axiscope service (Mainsail → Services → axiscope → Restart, or sudo systemctl restart axiscope).';

const TERMINAL = ['converged', 'not_converged', 'calibrated', 'failed', 'cancelled'];

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
  // Target lock: keeps live detection on one nozzle instead of jumping to
  // whichever circle scores best in each frame. {x, y, radius, rings}; x/y
  // are dropped (ring-size search) when the target moved out of the radius.
  lock: null,
  userLock: false,      // set by clicking the image; never dropped automatically
  _lockMisses: 0,
  _jobTimer: null,

  init() {
    this.settings = Object.assign({}, DETECTION_DEFAULTS, LS.get('detection', {}));
    this.align = Object.assign({}, ALIGN_DEFAULTS, LS.get('align', {}));
    if (!this.align.v) {   // v2: saved mappings became the default
      this.align.reuse_calibration = true;
      this.align.v = 2;
      LS.set('align', this.align);
    }
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
          if (key === 'min_radius' || key === 'max_radius') this.updateRadiusGuide();
          this.save();
          this.kick();
        });
    };
    dial('min_radius', { label: 'Min radius', min: 2, max: 400, unit: ' px', help: 'Ignore circles smaller than this. Raise it to skip specks and the orifice glint.' }, v => {
      if (s.max_radius <= v) { s.max_radius = v + 1; this.dials.max_radius.set(s.max_radius); }
    });
    dial('max_radius', { label: 'Max radius', min: 3, max: 600, unit: ' px', help: 'Ignore circles larger than this. Should just fit the nozzle tip.' }, v => {
      if (s.min_radius >= v) { s.min_radius = v - 1; this.dials.min_radius.set(s.min_radius); }
    });
    dial('hough_votes', { label: 'Vote threshold · param2', min: 5, max: 100, help: 'How round a shape must be to count as a circle. Lower finds more (and more false) circles.' });
    dial('canny_low', { label: 'Canny low', min: 5, max: 250, help: 'How faint an edge may get while it continues. About a third to half of high.' }, v => {
      if (s.canny_high <= v) { s.canny_high = v + 1; this.dials.canny_high.set(s.canny_high); }
    });
    dial('canny_high', { label: 'Canny high · param1', min: 10, max: 400, help: 'How sharp a light/dark change must be to start an edge. Raise if texture lights up.' }, v => {
      if (s.canny_low >= v) { s.canny_low = v - 1; this.dials.canny_low.set(s.canny_low); }
    });
    dial('blur', { label: 'Blur kernel', min: 0, max: 15, format: v => (v < 3 ? 'off' : (v | 1) + ' px'), help: 'Smooths noise and grain before edges are found. Raise for noisy or speckled images.' });
    dial('min_coverage', { label: 'Min ring coverage', min: 10, max: 100, unit: '%', help: 'How much of a ring must be visible edge. Lower if rings are partly hidden or glared.' });
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
    this.updateRadiusGuide();
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
    $('lock-release').addEventListener('click', () => this.releaseLock());
    $('mapping-forget').addEventListener('click', async () => {
      if (!S.camera) return;
      try {
        await fetch('/api/mapping?camera=' + encodeURIComponent(S.camera.snapshot), { method: 'DELETE' });
        notice('Camera mapping forgotten. The next Auto align measures it again.');
      } catch (e) { notice(e.message, 'error'); }
      this.loadMapping();
    });
    CameraView.onPick = (x, y) => { if (this.settings.enabled && !S.busy) this.lockAt(x, y); };
    $('check-orientation').addEventListener('click', () => this.startAlign('orient'));
    $('align-orient').addEventListener('click', () => {
      const r = this.job && this.job.result;
      if (r && r.mapping) this.applyOrientation(r.mapping);
    });
    $('jog-align-circle').addEventListener('click', () => this.startAlign());
    $('align-cancel').addEventListener('click', () => Api.alignCancel().catch(e => notice(e.message, 'error')));
    $('align-copy').addEventListener('click', async () => {
      if (!this.job) return;
      try { await copyText(this.logText(this.job)); notice('Alignment log copied to the clipboard.'); }
      catch (e) { notice(e.message, 'error'); }
    });
    $('align-retry').addEventListener('click', () => this.startAlign(this.job && this.job.mode === 'orient' ? 'orient' : 'align'));
    $('align-badge').addEventListener('click', () => $('align-panel').scrollIntoView({ block: 'center', behavior: 'smooth' }));
    $('align-dismiss').addEventListener('click', () => { $('align-badge').hidden = true; $('align-panel').hidden = true; this.job = null; this.schedule(true); });
    $('align-revert').addEventListener('click', async () => {
      $('align-revert').disabled = true;
      try {
        const r = await Api.alignRevert();
        notice(`Moved back to X ${r.position[0].toFixed(3)} Y ${r.position[1].toFixed(3)}.`);
        $('align-panel').hidden = true;
        $('align-badge').hidden = true;
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
      $('align-badge').hidden = true;
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
    // The page and the service update separately: the page reloads on its
    // own, the Python service only when restarted.
    const have = a.features || [];
    this.missing = a.opencv ? NEEDED_FEATURES.filter(f => !have.includes(f)) : [];
    // A service from before feature reporting can't say what it lacks.
    const missingText = a.features ? this.missing.join(', ') : 'it predates this version';
    $('service-banner').hidden = !this.missing.length;
    if (this.missing.length) {
      setText('service-banner', 'The Axiscope service is running older code than this page (' + missingText + '). ' + RESTART_HINT + ' Then reload this page.');
    }
    $('vision-status').textContent = a.opencv ? 'OpenCV ' + a.opencv_version + ' on the Axiscope host' : a.error || 'OpenCV unavailable';
    $('vision-pill').textContent = !a.opencv ? 'Unavailable' : this.missing.length ? 'Restart needed' : 'Ready';
    $('vision-pill').dataset.state = a.opencv && !this.missing.length ? 'ok' : 'warn';
    if (this.missing.length) $('vision-status').textContent += ' · service needs a restart (' + missingText + ')';
    $('det-engine').textContent = a.opencv ? 'OPENCV ' + a.opencv_version : 'UNAVAILABLE';
    if (!a.opencv) $('det-sub').textContent = 'OpenCV is not installed on the Axiscope host. Re-run install.sh to enable detection.';
    // Resume a job that was running before a page reload.
    if (a.align && !TERMINAL.includes(a.align.state) && a.align.state !== 'idle') {
      S.busy = true;
      this.showJob(a.align);
      this.pollJob();
    }
    this.renderEligibility();
    this.loadMapping();
    if (window.Minicam && Minicam.el) Minicam.refresh();
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
      const res = await Api.detect({ camera_url: S.camera.snapshot, params: this.params(), edges: this.settings.edges, lock: this.lock });
      this.last = res;
      this._fails = 0;
      this.updateLock(res);
      $('lock-release').hidden = !this.lock;
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

  // Follow the target from frame to frame (see `lock` above).
  updateLock(res) {
    const b = res.best;
    const rings = b ? b.rings.map(r => r.r) : [];
    const follow = () => {
      const rmax = Math.max(...rings);
      this.lock = { x: b.x, y: b.y, radius: Math.max(40, 0.6 * rmax), rings };
      this._lockMisses = 0;
    };
    if (!this.lock) { if (b) follow(); return; }
    if (res.locked && b) { follow(); return; }
    // Lost: first look for the same ring set anywhere (a big jog moved it),
    // then, for an automatic lock, start over on the best circle.
    if (this.lock.x != null && this.lock.rings && this.lock.rings.length) {
      this.lock = { rings: this.lock.rings };
      return;
    }
    if (++this._lockMisses >= 3 && !this.userLock) {
      this.lock = null;
      if (b) follow();
    }
  },

  lockAt(x, y) {
    const f = CameraView.frame;
    this.lock = { x, y, radius: Math.max(60, 0.08 * (f ? f.height : 720)), rings: [] };
    this.userLock = true;
    this._lockMisses = 0;
    $('lock-release').hidden = false;
    notice('Locked onto the circle at the click. Detection and auto align stay on it.');
    this.schedule(true);
  },

  releaseLock() {
    this.lock = null;
    this.userLock = false;
    $('lock-release').hidden = true;
    this.last = null;
    CameraView.setDetection(null);
    setText('detection-status', 'Lock released, searching the whole frame…');
    this.schedule(true);
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
    const kind = this.userLock ? 'locked (clicked)' : 'auto-locked';
    const lockNote = !this.lock ? ''
      : this.lock.x == null ? ` · ${kind}, searching by ring size`
      : res.locked === false ? ` · ${kind} target not found, showing best circle`
      : ` · ${kind}`;
    el.textContent = `${b.rings.length} ring${b.rings.length === 1 ? '' : 's'} · r ${radii} px · ${d.toFixed(1)} px from crosshair · ${Math.round(res.ms)} ms${lockNote}`;
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
    ['auto-align', 'jog-align-circle', 'check-orientation'].forEach(id => {
      $(id).disabled = !ok;
      $(id).title = why;
    });
    $('jog-align-circle').classList.toggle('detection-active', this.settings.enabled);
    $('camera-viewport').classList.toggle('can-pick', this.settings.enabled && !S.busy);
  },

  // ------------------------------------------------------- auto alignment
  async startAlign(mode = 'align') {
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
        mode,
        // Start from the locked target when its position is known.
        lock: this.lock && this.lock.x != null ? this.lock : null,
      });
      this.showJob(job);
      // The panel sits below the camera; bring it into view.
      $('align-panel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
        this.loadMapping();
        if (job.state === 'failed') notice('Auto alignment stopped: ' + job.message, 'error');
        $('align-panel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    const labels = { running: 'RUNNING', converged: 'CENTERED', not_converged: 'NOT WITHIN TOLERANCE', calibrated: 'ORIENTATION MEASURED', failed: 'FAILED', cancelled: 'CANCELLED', idle: 'IDLE' };
    setText('align-title-text', job.mode === 'orient' ? 'Camera orientation' : 'Auto alignment');
    $('align-state').textContent = labels[job.state] || job.state.toUpperCase();
    $('align-panel').dataset.state = job.state;
    $('align-cancel').hidden = job.state !== 'running';
    // Mirror progress on the camera image, where the user is looking.
    const badge = $('align-badge');
    badge.hidden = false;
    badge.dataset.state = job.state;
    setText(badge, job.state === 'running'
      ? 'AUTO ALIGN · ' + (job.message || 'starting…')
      : 'AUTO ALIGN · ' + (labels[job.state] || job.state.toUpperCase()) + ' · details below');
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
    const v = $('align-verdict');
    const orient = job.mode === 'orient';
    if (orient && r) {
      const m = r.mapping;
      $('align-metrics').innerHTML = [
        metric('SCALE', m.px_per_mm.toFixed(0) + '<small>px/mm</small>'),
        metric('+X MOVES IMAGE', m.x_dir.toUpperCase()),
        metric('+Y MOVES IMAGE', m.y_dir.toUpperCase()),
        metric('RETURN ERROR', r.return_error_px.toFixed(1) + '<small>px</small>'),
      ].join('');
      // Apply once per run, when the result first arrives.
      if (this._orientedRun !== job.started) {
        this._orientedRun = job.started;
        this.applyOrientation(m, true);
      }
      v.textContent = `Camera is rotated ${Math.round(m.rotation_deg)}°${m.mirrored ? ' and mirrored' : ''} relative to the machine. `
        + `The view now shows +X to the right and +Y up, so the jog arrows match the screen. `
        + (r.consistent ? 'The nozzle came back to where it started, so moves and camera agree.'
          : `The nozzle came back ${r.return_error_px.toFixed(1)} px (${r.return_error_mm.toFixed(3)} mm) off; check for backlash or image lag.`);
    } else {
      $('align-metrics').innerHTML = r ? [
        metric('RESIDUAL', r.error_mm.toFixed(4) + '<small>mm</small>'),
        metric('CORRECTIONS', r.corrections + ' / ' + this.align.max_iterations),
        metric('SCALE', r.mapping.px_per_mm.toFixed(0) + '<small>px/mm</small>'),
        metric('MOVED', `${signed(r.moved_mm[0])} / ${signed(r.moved_mm[1])}`),
      ].join('') : '';
      if (job.state === 'converged') {
        v.textContent = `T${job.tool} is centred within ${r.tolerance} mm. Check the camera view, then accept to capture this position.`;
      } else if (job.state === 'not_converged') {
        v.textContent = `Stopped after ${r.corrections} corrections, ${r.error_mm.toFixed(4)} mm from the crosshair (tolerance ${r.tolerance} mm). You can still accept, nudge it manually, or run again.`;
      } else if (job.state === 'failed') {
        v.textContent = job.message;
      } else {
        v.textContent = 'Cancelled. The toolhead stays where it stopped.';
      }
    }
    const canAccept = !orient && !!r && job.tool === activeTool();
    $('align-accept').hidden = orient || !r;
    $('align-accept').disabled = !canAccept;
    $('align-accept-label').textContent = job.tool === 0 ? 'Accept & capture reference' : `Accept & capture T${job.tool}`;
    $('align-revert').hidden = orient || !job.start_position;
    // After an alignment, the learned mapping can also orient the view.
    $('align-orient').hidden = orient || !(r && r.mapping);
  },

  updateRadiusGuide() {
    const s = this.settings;
    CameraView.radiusGuide = s.enabled ? { min: s.min_radius, max: s.max_radius } : null;
    CameraView.draw();
  },

  // Saved mapping for the current camera (from the backend).
  async loadMapping() {
    this.mapping = null;
    if (S.camera && this.available && this.available.opencv) {
      try {
        this.mapping = (await Api.call('/api/mapping?camera=' + encodeURIComponent(S.camera.snapshot))).mapping;
      } catch (e) { /* shown as "none saved" */ }
    }
    const m = this.mapping;
    setText('mapping-text', m
      ? `Camera mapping saved ${new Date(m.saved_at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}: `
        + `${Math.round(m.px_per_mm)} px/mm, +X moves the image ${m.x_dir}, +Y moves it ${m.y_dir}.`
      : 'No camera mapping saved yet. Map camera once, or the first Auto align measures it.');
    $('mapping-forget').hidden = !m;
    setText('check-orientation', m ? 'Redo mapping' : 'Map camera');
    // A camera without a view orientation of its own gets one from the mapping.
    if (m && S.camera && !LS.get('orient:' + S.camera.stream, null)) this.applyOrientation(m, true);
  },

  // Rotate/flip the camera *view* so +X is right and +Y is up on screen.
  // Detection and moves use the raw frame, so this is purely visual.
  applyOrientation(mapping, quiet) {
    const t = viewForMapping(mapping);
    Object.assign(S.view, { rotate: t.rotate, flipH: t.flipH, flipV: t.flipV });
    LS.set('view', S.view);
    saveOrientation();
    renderView();
    if (!quiet) notice(`View turned ${t.rotate}°${t.flipH ? ' and mirrored' : ''}: the jog arrows now match the screen.`);
  },

  // Plain-text run log for bug reports.
  logText(job) {
    const lines = [(job.mode === 'orient' ? 'Camera orientation' : 'Auto alignment') + ' · ' + job.state + (job.tool != null ? ' · T' + job.tool : '')];
    (job.steps || []).forEach(st => lines.push(st.phase.padEnd(12) + st.message));
    if (job.result && job.result.mapping) lines.push('mapping ' + JSON.stringify(job.result.mapping));
    lines.push('settings ' + JSON.stringify(this.align));
    lines.push('detection ' + JSON.stringify(this.params()));
    return lines.join('\n');
  },

  // A different camera gets a fresh start.
  resetBackoff() {
    this._fails = 0;
    this.schedule(true);
  },

  stopAll() {
    clearTimeout(this._timer);
    this._fails = 0;
    this.lock = null;
    this.userLock = false;
    this.last = null;
    CameraView.setDetection(null);
  },
};
