// Axiscope UI: connection, live printer state, tool alignment, offsets, setup.
// Vision (detection + auto alignment) lives in vision.js.

// ------------------------------------------------------------------ helpers
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const signed = n => (n >= 0 ? '+' : '') + n.toFixed(3);

function store(kind) {
  const backend = () => (kind === 'session' ? window.sessionStorage : window.localStorage);
  return {
    get(key, fallback) {
      try { const v = backend().getItem('axiscope.' + key); return v == null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { backend().setItem('axiscope.' + key, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
    },
  };
}
const LS = store('local');
const SS = store('session');

// Write only on change: rewriting identical text every poll would clear the
// user's text selection (and cost layout work).
function setText(id, text) {
  const el = typeof id === 'string' ? $(id) : id;
  if (el.textContent !== text) el.textContent = text;
}
function setHTML(id, html) {
  const el = typeof id === 'string' ? $(id) : id;
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

function notice(message, kind = 'info') {
  const n = $('notice');
  n.textContent = message || '';
  n.dataset.kind = kind;
}

async function copyText(text) {
  // navigator.clipboard needs a secure context; plain-http LAN pages fall back.
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('Copy was blocked by the browser');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// A labelled range control in the design's "DetectionDial" style.
function buildDial(container, spec, onInput) {
  const fmt = spec.format || (v => v + (spec.unit || ''));
  container.outerHTML = `<label class="detection-control" for="${spec.id}">
    <span>${esc(spec.label)}<output for="${spec.id}" id="${spec.id}-out">${esc(fmt(spec.value))}</output></span>
    <input id="${spec.id}" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step || 1}" value="${spec.value}"${spec.help ? ` aria-describedby="${spec.id}-help"` : ''}>
    ${spec.help ? `<small class="dial-help" id="${spec.id}-help">${esc(spec.help)}</small>` : ''}
  </label>`;
  const input = $(spec.id), out = $(spec.id + '-out');
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onInput(v);
  });
  return {
    set(v) { input.value = v; out.textContent = fmt(v); },
    input,
  };
}

// -------------------------------------------------------------------- state
const S = {
  tab: 'calibration',
  host: LS.get('host', ''),
  camera: LS.get('camera', null),       // {name, stream, snapshot}
  cameras: [],
  online: false,
  status: null,                         // parsed printer state, see parseStatus()
  ref: null,                            // T0 capture {x, y, z}
  grabs: {},                            // tool -> {x, y, ox, oy} (position + offset at capture)
  saved: {},                            // tool -> true once written to config
  step: LS.get('step', 0.1),
  view: Object.assign({ crosshair: true, zoom: 1, flipH: false, flipV: false, rotate: 0, contrast: 100 }, LS.get('view', {})),
  led: Object.assign({ enabled: false, pwm: 60, template: '' }, LS.get('led', {})),
  busy: false,                          // auto alignment in progress
};

function loadCaptures() {
  const c = SS.get('captures:' + S.host, {});
  S.ref = c.ref || null;
  S.grabs = c.grabs || {};
  S.saved = c.saved || {};
}
function saveCaptures() {
  SS.set('captures:' + S.host, { ref: S.ref, grabs: S.grabs, saved: S.saved });
}

// -------------------------------------------------------------------- theme
const TWEAK_DEFAULTS = { accentColor: '#b5ef6b', backgroundColor: '#101211', panelColor: '#171b16', density: 0.75, cornerRadius: 14 };
const THEME_PRESETS = {
  precision: { accentColor: '#b5ef6b', backgroundColor: '#101211', panelColor: '#171b16', density: 0.85, cornerRadius: 7 },
  arctic: { accentColor: '#79d5f5', backgroundColor: '#10151b', panelColor: '#18222c', density: 0.85, cornerRadius: 7 },
  copper: { accentColor: '#f5b27c', backgroundColor: '#191311', panelColor: '#241c18', density: 0.85, cornerRadius: 5 },
};

function applyTheme(theme) {
  const t = theme || TWEAK_DEFAULTS;
  const app = $('app');
  app.style.setProperty('--accent', t.accentColor);
  app.style.setProperty('--canvas', t.backgroundColor);
  app.style.setProperty('--surface', t.panelColor);
  app.style.setProperty('--density', t.density);
  app.style.setProperty('--radius', t.cornerRadius + 'px');
  document.body.style.background = t.backgroundColor;
}

function validateTheme(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Use a JSON object with the five theme properties.');
  const keys = Object.keys(TWEAK_DEFAULTS);
  if (Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !(k in value))) throw new Error('Include only accentColor, backgroundColor, panelColor, density and cornerRadius.');
  for (const key of ['accentColor', 'backgroundColor', 'panelColor']) {
    if (typeof value[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value[key])) throw new Error(key + ' must be a six-digit hex color, such as #b5ef6b.');
  }
  if (typeof value.density !== 'number' || value.density < 0.75 || value.density > 1.15) throw new Error('density must be a number from 0.75 to 1.15.');
  if (!Number.isInteger(value.cornerRadius) || value.cornerRadius < 0 || value.cornerRadius > 14) throw new Error('cornerRadius must be an integer from 0 to 14.');
  const luminance = color => {
    const rgb = color.slice(1).match(/../g).map(c => parseInt(c, 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  if (luminance(value.backgroundColor) > 0.12 || luminance(value.panelColor) > 0.12) throw new Error('Use dark backgrounds to keep the fixed light text readable.');
  if (luminance(value.accentColor) < 0.4) throw new Error('Use a brighter accent for readable controls and focus rings.');
  return value;
}

function initTheme() {
  let theme = LS.get('theme', null);
  try { if (theme) validateTheme(theme); } catch (e) { theme = null; }
  applyTheme(theme);
  const json = $('theme-json'), fb = $('theme-feedback');
  const feedback = (msg, isError) => {
    fb.textContent = msg;
    fb.className = isError ? 'theme-error' : 'theme-feedback';
    json.setAttribute('aria-invalid', isError ? 'true' : 'false');
  };
  json.value = JSON.stringify(theme || TWEAK_DEFAULTS, null, 2);
  json.addEventListener('input', () => feedback('', false));
  $('theme-preset').addEventListener('change', e => {
    json.value = JSON.stringify(THEME_PRESETS[e.target.value], null, 2);
    feedback('Preset loaded. Apply theme to use it.', false);
  });
  $('theme-apply').addEventListener('click', () => {
    try {
      theme = validateTheme(JSON.parse(json.value));
      applyTheme(theme);
      LS.set('theme', theme);
      json.value = JSON.stringify(theme, null, 2);
      feedback('Theme applied across this workspace.', false);
    } catch (e) {
      feedback(e instanceof SyntaxError ? 'Invalid JSON. Check quotes, commas and brackets.' : e.message, true);
    }
  });
  $('theme-reset').addEventListener('click', () => {
    theme = null;
    LS.set('theme', null);
    applyTheme(null);
    json.value = JSON.stringify(TWEAK_DEFAULTS, null, 2);
    $('theme-preset').value = '';
    feedback('Default theme restored.', false);
  });
  $('theme-export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(theme || TWEAK_DEFAULTS, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'axiscope-theme.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    feedback('Exported the currently applied theme.', false);
  });
}

// --------------------------------------------------------------- navigation
const HEADINGS = {
  offsets: ['Tool offsets', 'Review your captured offsets relative to T0.'],
  setup: ['Workspace setup', 'Your printer and camera, in one place.'],
};

function navigate(tab) {
  S.tab = tab;
  document.querySelectorAll('nav [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['calibration', 'offsets', 'setup'].forEach(t => { $('view-' + t).hidden = t !== tab; });
  $('page-heading').hidden = tab === 'calibration';
  if (HEADINGS[tab]) {
    setText('page-title', HEADINGS[tab][0]);
    setText('page-sub', HEADINGS[tab][1]);
  }
  notice('');
  if (tab === 'calibration') CameraView.fit();
  if (tab === 'setup' && S.online) refreshCameras();
  Vision.schedule();
}

// --------------------------------------------------------------- connection
async function connect(host, { auto = false } = {}) {
  host = host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const status = $('conn-status');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9](:[0-9]+)?$/.test(host) && !/^\[[0-9a-fA-F:]+\](:[0-9]+)?$/.test(host)) {
    status.textContent = 'Enter an IP address or host name, optionally with :port.';
    status.dataset.kind = 'error';
    return false;
  }
  stopPolling();
  // Without a port, Moonraker may sit behind the web server (:80) or on its
  // own default port (:7125). Probe both at once; prefer :80 when both answer,
  // because camera proxy paths (/webcam/, /webcam2/) are served there.
  const hasPort = /:\d+$/.test(host);
  const candidates = hasPort ? [host] : [host, host + ':7125'];
  status.textContent = 'Looking for Moonraker on ' + candidates.join(' and ') + '…';
  status.dataset.kind = '';
  $('connect-btn').disabled = true;
  try {
    const results = await Promise.allSettled(candidates.map(h => Printer.probe(h)));
    const hit = results.findIndex(r => r.status === 'fulfilled');
    if (hit < 0) throw results[0].reason;
    host = candidates[hit];
    const info = results[hit].value;
    Printer.host = host;
    $('printer-ip').value = host;
    S.host = host;
    LS.set('host', host);
    loadCaptures();
    status.textContent = info.klippy_connected
      ? 'Connected · Klippy ' + info.klippy_state
      : 'Moonraker reachable, but Klippy is ' + info.klippy_state + '. Positions appear once Klipper is ready.';
    status.dataset.kind = info.klippy_connected ? 'ok' : 'error';
    $('printer-ip').disabled = true;
    $('connect-btn').hidden = true;
    $('disconnect-btn').hidden = false;
    startPolling();
    await refreshCameras(true);
    // Keep the saved camera if it still exists; with a single camera there is nothing to choose.
    const saved = S.camera && (S.cameras.find(c => c.stream === S.camera.stream) || S.cameras.find(c => c.name === S.camera.name));
    if (saved) selectCamera(saved, { keepView: true, stay: !auto });
    else if (S.cameras.length === 1) selectCamera(S.cameras[0], { stay: false });
    if (!S.cameras.length) status.textContent += ' · No cameras found in Moonraker or crowsnest.conf.';
    return true;
  } catch (e) {
    status.textContent = auto ? '' : 'No Moonraker answered at ' + candidates.join(' or ') + ' (' + e.message + '). Check the address, and that this page’s origin is in Moonraker’s cors_domains.';
    status.dataset.kind = 'error';
    return false;
  } finally {
    $('connect-btn').disabled = false;
    renderAll();
  }
}

function disconnect() {
  stopPolling();
  Vision.stopAll();
  S.online = false;
  S.status = null;
  S.cameras = [];
  CameraView.setStream(null);
  $('printer-ip').disabled = false;
  $('connect-btn').hidden = false;
  $('disconnect-btn').hidden = true;
  setText('conn-status', 'Disconnected.');
  $('conn-status').dataset.kind = '';
  renderCameraList();
  $('camera-list').hidden = true;
  $('manual-cam-form').hidden = true;
  renderAll();
}

// Cameras come from two places: Moonraker's webcam list (what Mainsail /
// Fluidd show) and crowsnest.conf, which can hold cameras never added to the
// web UI. Crowsnest entries already covered by the webcam list are skipped.
const normUrl = u => u.toLowerCase().replace(/\/\?/, '?').replace(/[?&]_probe=\d+/, '');
// Origin + directory: /webcam/?action=stream and /webcam/stream are one camera.
const dirOf = u => {
  try { const p = new URL(u); return (p.origin + p.pathname.replace(/[^/]*$/, '')).toLowerCase(); }
  catch (e) { return normUrl(u); }
};

// Probe results are remembered so the periodic refresh doesn't keep hitting
// (and logging errors for) cameras that are down. Failures are retried after
// a few minutes, or right away on Rescan.
const probeCache = new Map();   // snapshot URL -> {ok, t}
const PROBE_RETRY_MS = 5 * 60 * 1000;
async function probeCached(url, force) {
  const hit = probeCache.get(url);
  if (!force && hit && (hit.ok || Date.now() - hit.t < PROBE_RETRY_MS)) return hit.ok;
  const ok = await Printer.probeImage(url);
  probeCache.set(url, { ok, t: Date.now() });
  return ok;
}

// Cameras added by URL in Setup, remembered per printer.
const manualCams = () => LS.get('manualCams:' + S.host, []);
const saveManualCams = cams => LS.set('manualCams:' + S.host, cams);

async function discoverCameras(force) {
  const [listed, crow] = await Promise.all([Printer.webcams().catch(() => []), Printer.crowsnestCams()]);
  const cams = listed.map(c => Object.assign({
    name: c.name, source: 'Moonraker', service: c.service || 'webcam',
    flipH: !!c.flip_horizontal, flipV: !!c.flip_vertical, reachable: true,
  }, Printer.cameraUrls(c)));
  // Probe in parallel but keep crowsnest.conf order.
  const crowCams = await Promise.all(crow.map(async c => {
    const options = Printer.crowsnestUrls(c);
    // Already listed by Moonraker (same name, or served from the same path)?
    const known = cams.some(k => k.name.toLowerCase() === c.name.toLowerCase()
      || options.some(o => dirOf(o.stream) === dirOf(k.stream)));
    if (known) return null;
    let found = null;
    for (const o of options) {
      if (await probeCached(o.snapshot, force)) { found = o; break; }
    }
    const pick = found || options[0];
    return {
      name: c.name, source: 'crowsnest', service: (c.mode || 'streamer') + ' · ' + pick.via,
      flipH: false, flipV: false, reachable: !!found, stream: pick.stream, snapshot: pick.snapshot,
    };
  }));
  crowCams.forEach(c => { if (c) cams.push(c); });
  const manual = await Promise.all(manualCams().map(async c => Object.assign({
    source: 'manual', service: 'stream URL', flipH: false, flipV: false, manual: true,
    reachable: await probeCached(c.snapshot, force),
  }, c)));
  return cams.concat(manual);
}

let cameraKey = '';
async function refreshCameras(force = false) {
  if (!S.host) return;
  const btn = $('rescan-cameras');
  if (btn) btn.disabled = true;
  const cams = await discoverCameras(force === true);
  if (!S.host) return;  // disconnected meanwhile
  const key = JSON.stringify(cams.map(c => [c.name, c.stream, c.reachable]));
  S.cameras = cams;
  if (key !== cameraKey || !$('rescan-cameras')) { cameraKey = key; renderCameraList(); }
  else if (btn) btn.disabled = false;
}

function renderCameraList() {
  const list = $('camera-list');
  list.hidden = !S.host;
  const head = `<div class="camera-list-head"><p class="theme-label">Select camera <span>${S.cameras.length} found</span></p>
    <button type="button" class="text-button" id="rescan-cameras">${iconSvg('reset', 13)} Rescan</button></div>`;
  list.innerHTML = head + (S.cameras.length ? '' : '<p class="empty-note">No cameras found. Check crowsnest and your webcam settings in Mainsail or Fluidd.</p>') + S.cameras.map((cam, i) => {
    const selected = S.camera && S.camera.stream === cam.stream;
    const state = !cam.reachable ? ' · not reachable' : selected ? ' · in use' : ' · click to use';
    return `<div class="camera-row"><button type="button" class="camera-option${selected ? ' selected' : ''}${cam.reachable ? '' : ' unreachable'}" data-cam="${i}" aria-pressed="${selected}">
      ${cam.reachable ? `<img src="${esc(cam.snapshot)}" alt="" loading="lazy">` : '<span class="cam-placeholder" aria-hidden="true"></span>'}
      <span><b>${esc(cam.name)}</b><small>${esc(cam.source)} · ${esc(cam.service)}${state}</small></span>
    </button>${cam.manual ? `<button type="button" class="text-button" data-remove-cam="${i}" aria-label="Remove ${esc(cam.name)}">Remove</button>` : ''}</div>`;
  }).join('');
  $('manual-cam-form').hidden = list.hidden;
  list.querySelectorAll('[data-remove-cam]').forEach(b => b.addEventListener('click', () => {
    const cam = S.cameras[Number(b.dataset.removeCam)];
    saveManualCams(manualCams().filter(c => c.stream !== cam.stream));
    refreshCameras();
  }));
  list.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => selectCamera(S.cameras[Number(b.dataset.cam)])));
  $('rescan-cameras').addEventListener('click', () => refreshCameras(true));
  if (window.Minicam && Minicam.el) Minicam.refresh();
}

async function addManualCamera(e) {
  e.preventDefault();
  const status = $('manual-cam-status');
  let raw = $('manual-cam-url').value.trim();
  if (!raw) return;
  let stream;
  if (/^https?:\/\//i.test(raw)) stream = raw;              // typed in full: use as is
  else if (raw.startsWith('/')) stream = 'http://' + Printer.webHost() + raw;
  else stream = 'http://' + raw;                            // host:port/path without scheme
  try { new URL(stream); } catch (err) {
    status.textContent = 'That is not a valid URL.'; status.dataset.kind = 'error'; return;
  }
  // Player pages (go2rtc stream.html, camera-streamer /webrtc) become their MJPEG endpoints.
  let snapshot;
  ({ stream, snapshot } = mjpegUrls(stream, null));
  if (!snapshot) {
    status.textContent = 'Axiscope needs an MJPEG stream it can grab single frames from: a URL ending in ?action=stream or /stream, or a go2rtc link with ?src=.';
    status.dataset.kind = 'error';
    return;
  }
  if (S.cameras.some(c => normUrl(c.stream) === normUrl(stream))) {
    status.textContent = 'That camera is already in the list.'; status.dataset.kind = ''; return;
  }
  $('manual-cam-add').disabled = true;
  status.textContent = 'Checking ' + snapshot + '…'; status.dataset.kind = '';
  const ok = await Printer.probeImage(snapshot);
  $('manual-cam-add').disabled = false;
  const u = new URL(stream);
  const cam = { name: u.host + u.pathname.replace(/\/$/, ''), stream, snapshot };
  saveManualCams(manualCams().concat([cam]));
  $('manual-cam-url').value = '';
  status.textContent = ok ? 'Camera added.' : 'Added, but no image came back from ' + snapshot + '. Check the URL and that the streamer accepts connections from this computer.';
  status.dataset.kind = ok ? 'ok' : 'error';
  await refreshCameras();
}

// While Setup is open, look for cameras that were added or came online.
setInterval(() => { if (S.tab === 'setup' && S.online && !document.hidden) refreshCameras(); }, 15000);

// View rotation/flip is remembered per camera, so a sideways nozzle camera
// and an upright chamber camera each keep their own orientation.
function saveOrientation() {
  if (S.camera) LS.set('orient:' + S.camera.stream, { rotate: S.view.rotate || 0, flipH: S.view.flipH, flipV: S.view.flipV });
}

function selectCamera(cam, { keepView = false, stay = false } = {}) {
  S.camera = { name: cam.name, stream: cam.stream, snapshot: cam.snapshot };
  LS.set('camera', S.camera);
  const orient = LS.get('orient:' + cam.stream, null);
  if (orient) {
    Object.assign(S.view, orient);
    LS.set('view', S.view);
  } else if (!keepView) {
    Object.assign(S.view, { flipH: cam.flipH, flipV: cam.flipV, rotate: 0 });
    LS.set('view', S.view);
  }
  CameraView.setStream(cam.stream);
  Vision.releaseLock();
  Vision.loadMapping();
  if (window.Minicam && Minicam.el) Minicam.refresh();
  Vision.resetBackoff();
  CameraView.applyView();
  renderCameraList();
  renderView();
  if (!stay) navigate('calibration');
}

// ------------------------------------------------------------------ polling
let pollTimer = null, polling = false;

function startPolling() {
  stopPolling();
  poll();
  pollTimer = setInterval(poll, 1000);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

async function poll() {
  if (polling || !S.host) return;
  polling = true;
  const toolObjects = S.status ? S.status.toolNames : [];
  try {
    const st = await Printer.query(['gcode_move', 'toolhead', 'toolchanger', 'quad_gantry_level', 'stepper_enable', 'axiscope', ...toolObjects]);
    S.status = parseStatus(st);
    S.online = true;
  } catch (e) {
    S.online = false;
  } finally {
    polling = false;
    renderAll();
  }
}

function parseStatus(st) {
  const gm = st.gcode_move || {}, th = st.toolhead || {}, tc = st.toolchanger || null;
  const offsets = {};
  const names = (tc && tc.tool_names) || [];
  const numbers = (tc && tc.tool_numbers) || [];
  names.forEach((name, i) => {
    const t = st[name];
    if (t) offsets[numbers[i]] = { x: t.gcode_x_offset || 0, y: t.gcode_y_offset || 0, z: t.gcode_z_offset || 0 };
  });
  const steppers = (st.stepper_enable && st.stepper_enable.steppers) || {};
  return {
    pos: gm.gcode_position || null,
    homed: th.homed_axes || '',
    axisMin: th.axis_minimum, axisMax: th.axis_maximum,
    qgl: st.quad_gantry_level ? !!st.quad_gantry_level.applied : null,
    motors: Object.values(steppers).some(Boolean),
    toolchanger: !!tc,
    tool: tc && tc.tool_number != null ? tc.tool_number : -1,
    tools: numbers,
    toolNames: names,
    offsets,
    axiscope: st.axiscope || null,
  };
}

const isHomed = () => !!S.status && ['x', 'y', 'z'].every(a => S.status.homed.includes(a));
const activeTool = () => (S.status ? S.status.tool : -1);
const toolName = n => {
  const st = S.status;
  const i = st ? st.tools.indexOf(n) : -1;
  return i >= 0 ? st.toolNames[i] : 'tool T' + n;
};

// ------------------------------------------------------------------ offsets
function newOffset(n) {
  const g = S.grabs[n];
  if (n === 0 || !g || !S.ref) return null;
  // Machine position of the aligned nozzle relative to T0's, plus the
  // offset that was active when the position was captured.
  return { x: g.x - S.ref.x + g.ox, y: g.y - S.ref.y + g.oy };
}

function zOffset(n) {
  const pr = S.status && S.status.axiscope && S.status.axiscope.probe_results;
  const r = pr && (pr[n] || pr[String(n)]);
  return r && typeof r.z_offset === 'number' ? r : null;
}

function capturedCount() {
  const tools = S.status ? S.status.tools : [];
  return tools.filter(n => n !== 0 && newOffset(n)).length;
}

// ---------------------------------------------------------------- rendering
function renderAll() {
  renderStatus();
  renderWorkflow();
  renderTools();
  renderPositions();
  renderMachine();
  renderOffsets();
  renderConfig();
  renderExtras();
  renderBusy();
}

function renderStatus() {
  const st = S.status;
  const label = !S.host ? 'OFFLINE' : S.online ? 'CONNECTED' : 'RECONNECTING';
  setText('conn-label', label);
  $('conn-label').dataset.state = S.online ? 'ok' : 'off';
  setHTML('footer-status', !S.host ? 'Not connected <span class="footer-divider">/</span> Connect in Setup'
    : S.online ? `Connected to ${esc(S.host)} <span class="footer-divider">/</span> ${isHomed() ? 'Homed' : 'Not homed'}`
      : `Connection to ${esc(S.host)} lost <span class="footer-divider">/</span> Retrying`);
  ['footer-dot', 'chip-dot'].forEach(id => $(id).classList.toggle('is-off', !S.online));
  setText('chip-host', S.host || 'Not connected');
  setText('chip-sub', st ? (st.toolchanger ? st.tools.length + ' tools' : 'No [toolchanger] found') + ' · Klipper' : 'Klipper · Moonraker');
  setText('chip-tools', st && st.tools.length ? 'T0–T' + Math.max(...st.tools) : '–');
}

function renderWorkflow() {
  const tools = S.status ? S.status.tools.filter(n => n !== 0) : [];
  const done = capturedCount();
  const step = (id, state, num) => {
    const el = $(id);
    el.classList.toggle('complete', state === 'complete');
    el.classList.toggle('current', state === 'current');
    setHTML(el.querySelector('.step-num'), state === 'complete' ? iconSvg('check', 13) : num);
  };
  const allDone = tools.length > 0 && done === tools.length;
  step('wf-ref', S.ref ? 'complete' : 'current', '01');
  step('wf-align', !S.ref ? '' : allDone ? 'complete' : 'current', '02');
  step('wf-review', allDone ? 'current' : '', '03');
  setText('wf-ref-sub', S.ref ? 'T0 position captured' : 'Capture the T0 position');
  setText('wf-align-sub', `${done} of ${tools.length} tools calibrated`);
  setText('session-tag', Vision.settings.enabled ? 'AUTO XY · OPENCV' : 'MANUAL XY');
}

let renderedTools = '';
function renderTools() {
  const st = S.status;
  const tools = st ? st.tools : [];
  const tn = activeTool();
  setText('tool-count', tools.length ? tools.length + ' tools available' : st && !st.toolchanger ? 'No toolchanger' : 'No tools');
  const big = tools.length > 12;
  $('tool-select-wrap').hidden = !big;
  $('tool-tabs').hidden = big;
  const key = tools.join(',') + '|' + tn + '|' + Object.keys(S.grabs).join(',') + (S.ref ? 'r' : '');
  if (key !== renderedTools) {
    renderedTools = key;
    $('tool-tabs').innerHTML = tools.map(n => {
      const cap = n === 0 ? !!S.ref : !!newOffset(n);
      return `<button type="button" id="tool-${n}" data-tool="${n}" aria-pressed="${n === tn}" class="${n === tn ? 'selected' : ''}" title="${n === tn ? 'Active tool' : 'Change to T' + n}">T${n}${cap ? '<i></i>' : ''}</button>`;
    }).join('');
    setHTML('tool-select', tools.map(n => `<option value="${n}"${n === tn ? ' selected' : ''}>T${n}${n === 0 ? ' · Reference' : newOffset(n) ? ' · Captured' : ' · Not calibrated'}</option>`).join(''));
    if (tn < 0 && big) $('tool-select').insertAdjacentHTML('afterbegin', '<option selected disabled>No tool</option>');
  }
  const desc = $('tool-desc'), sub = $('tool-desc-sub');
  if (!S.host) { setText(desc, 'Connect a printer'); setText(sub, 'Set the printer address in Setup'); }
  else if (tn < 0) { setText(desc, 'No tool picked up'); setText(sub, 'Select a tool to run a tool change'); }
  else if (tn === 0) { setText(desc, 'Reference tool'); setText(sub, 'The origin for all other tools'); }
  else { setText(desc, 'Align T' + tn + ' to reference'); setText(sub, 'Center the nozzle on the crosshair'); }

  setHTML('tool-overlay', tn < 0 ? 'T– <span>NO TOOL</span>' : `T${tn} <span>${tn === 0 ? 'REFERENCE' : 'ACTIVE TOOL'}</span>`);
  setText('capture-label', tn === 0 ? 'Capture reference' : tn > 0 ? 'Capture T' + tn + ' position' : 'Capture position');
  let hint = 'Offsets are calculated relative to T0';
  if (tn === 0) hint = S.ref ? `Reference X ${S.ref.x.toFixed(3)} · Y ${S.ref.y.toFixed(3)} · recapture to update` : 'Center T0 on the crosshair, then capture';
  else if (tn > 0) hint = !S.ref ? 'Capture T0 first; offsets are relative to it' : S.grabs[tn] ? 'Captured · recapture to update this position' : 'Center the nozzle, then capture';
  setText('capture-hint', hint);
}

function renderPositions() {
  const p = S.status && S.status.pos;
  const f = v => (p ? v.toFixed(3) : '—');
  setText('cc-x', p ? f(p[0]) : '—');
  setText('cc-y', p ? f(p[1]) : '—');
  setText('cc-z', p ? f(p[2]) : '—');
  setHTML('pos-x', (p ? f(p[0]) : '—') + '<small>mm</small>');
  setHTML('pos-y', (p ? f(p[1]) : '—') + '<small>mm</small>');
}

function renderMachine() {
  const st = S.status;
  const set = (id, ok, label) => {
    const b = $(id);
    b.dataset.state = !st ? '' : ok ? 'ok' : 'warn';
    if (label) setText(b, label);
  };
  set('btn-home', isHomed(), isHomed() ? 'Homed' : 'Home');
  $('btn-qgl').hidden = !st || st.qgl === null;
  set('btn-qgl', st && st.qgl, st && st.qgl ? 'QGL ✓' : 'QGL');
  set('btn-motors', st && st.motors, st && st.motors ? 'Motors off' : 'Motors idle');
}

function offsetCard(n, full) {
  const tn = activeTool();
  const off = S.status && S.status.offsets[n];
  const neu = newOffset(n);
  const z = zOffset(n);
  let state = 'Not calibrated', ready = false;
  if (n === 0) { state = S.ref ? 'Reference' : 'Reference · not captured'; ready = !!S.ref; }
  else if (neu) { state = S.saved[n] ? 'Saved' : 'Captured'; ready = true; }
  const val = (axis) => {
    if (neu) return signed(neu[axis]);
    if (n === 0) return off ? signed(off[axis]) : '—';
    return '—';
  };
  let extra = '';
  if (full && off) {
    const d = neu ? ` · Δ ${signed(neu.x - off.x)} / ${signed(neu.y - off.y)}` : '';
    extra = `<div class="offset-extra">Current ${signed(off.x)} / ${signed(off.y)}${d}</div>`;
  }
  if (full && z) extra += `<div class="offset-extra">Z ${n === 0 ? 'trigger ' + z.z_trigger.toFixed(3) : 'offset ' + signed(z.z_offset)}</div>`;
  return `<button type="button" id="offset-${n}" data-offset-tool="${n}" class="offset-card ${n === tn ? 'is-active' : ''}">
    <div class="offset-top"><span class="tool-badge">T${n}</span><span class="offset-state ${ready ? 'ready' : ''}">${state}${ready ? iconSvg('check', 12) : ''}</span></div>
    <div class="offset-values"><span>X <b>${val('x')}</b></span><span>Y <b>${val('y')}</b></span></div>${extra}
  </button>`;
}

function renderOffsets() {
  const tools = S.status ? S.status.tools : [];
  const count = capturedCount() + (S.ref ? 1 : 0);
  const section = (full) => `<section class="offset-section" aria-labelledby="offset-list-title-${full ? 'f' : 'r'}">
    <div class="section-heading">
      <div><h2 id="offset-list-title-${full ? 'f' : 'r'}">Tool offsets <span class="count">${count} / ${tools.length}</span></h2><p>New gcode offsets · millimeters</p></div>
      ${full ? '' : `<button type="button" class="secondary" id="review" ${tools.length ? '' : 'disabled'}>Review offsets${iconSvg('arrow', 14)}</button>`}
    </div>
    <div class="offset-grid">${tools.map(n => offsetCard(n, full)).join('') || '<p class="empty-note">Tools appear here once a printer with [toolchanger] is connected.</p>'}</div>
  </section>`;
  const html = section(false), fullHtml = section(true);
  if ($('rail-offsets').dataset.html !== html) { $('rail-offsets').innerHTML = html; $('rail-offsets').dataset.html = html; }
  if ($('offsets-list').dataset.html !== fullHtml) { $('offsets-list').innerHTML = fullHtml; $('offsets-list').dataset.html = fullHtml; }
}

function configText() {
  const tools = S.status ? S.status.tools.filter(n => n !== 0) : [];
  const lines = ['# Klipper tool offsets · millimeters', '# New value = offset at capture + measured shift relative to T0.', '# T0 is the reference and is not changed.'];
  tools.forEach(n => {
    const o = newOffset(n), z = zOffset(n);
    lines.push('');
    if (!o) { lines.push(`# [${toolName(n)}] not captured — no changes`); return; }
    lines.push(`[${toolName(n)}]`, 'gcode_x_offset: ' + o.x.toFixed(3), 'gcode_y_offset: ' + o.y.toFixed(3));
    if (z) lines.push('gcode_z_offset: ' + z.z_offset.toFixed(3));
  });
  return lines.join('\n');
}

function renderConfig() {
  const tools = S.status ? S.status.tools.filter(n => n !== 0) : [];
  const done = capturedCount();
  setText('config-code', configText());
  setText('config-count', `${done} / ${tools.length} tools`);
  const captured = tools.filter(n => newOffset(n));
  const allSaved = captured.length > 0 && captured.every(n => S.saved[n]);
  setText('config-state', allSaved ? 'SAVED TO CONFIG' : 'PROPOSED CHANGES');
  const canSave = !!(S.status && S.status.axiscope && S.status.axiscope.can_save_config);
  $('save-config').disabled = !canSave || !done;
  $('copy-config').disabled = !done;
  setHTML('config-note', !S.status || !S.status.axiscope
    ? 'The [axiscope] Klipper module is not loaded, so saving is unavailable. Copy the lines into your tool sections instead.'
    : !canSave
      ? 'Set <code>config_file_path</code> in [axiscope] to save offsets from here. Until then, copy the lines into your tool sections.'
      : 'Saving writes through AXISCOPE_SAVE_TOOL_OFFSET to the file in <code>config_file_path</code>. Restart Klipper afterwards to load the new offsets.');
}

function renderExtras() {
  const ax = S.status && S.status.axiscope;
  $('zcal-panel').hidden = !ax;
  const st = S.status;
  const showMap = ax && st.axisMin && st.axisMax;
  $('endstop-panel').hidden = !showMap;
  if (showMap) renderBedMap(ax, st.axisMin, st.axisMax, st.pos);
}

function renderBedMap(ax, axisMin, axisMax, pos) {
  const svg = $('bed-map');
  const pad = 24, maxDim = 220;
  const [minX, minY] = axisMin, [maxX, maxY] = axisMax;
  const rx = maxX - minX || 1, ry = maxY - minY || 1;
  const s = maxDim / Math.max(rx, ry);
  const W = Math.round(rx * s) + pad * 2, H = Math.round(ry * s) + pad * 2;
  const to = (x, y) => [pad + (x - minX) * s, pad + (maxY - y) * s];
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  const [bx1, by1] = to(minX, maxY), [bx2, by2] = to(maxX, minY);
  let html = `<rect x="${bx1}" y="${by1}" width="${bx2 - bx1}" height="${by2 - by1}" class="bm-bed"/>
    <text x="${bx1 + 3}" y="${by1 + 11}" class="bm-label">${minX},${maxY}</text>
    <text x="${bx2 - 3}" y="${by1 + 11}" class="bm-label" text-anchor="end">${maxX},${maxY}</text>
    <text x="${bx1 + 3}" y="${by2 - 4}" class="bm-label">${minX},${minY}</text>
    <text x="${bx2 - 3}" y="${by2 - 4}" class="bm-label" text-anchor="end">${maxX},${minY}</text>`;
  if (ax.endstop_x != null && ax.endstop_y != null) {
    const [ex, ey] = to(ax.endstop_x, ax.endstop_y);
    html += `<path d="M${ex - 5} ${ey}h10M${ex} ${ey - 5}v10" class="bm-switch"/>
      <text x="${ex > W / 2 ? ex - 7 : ex + 7}" y="${ey > H / 2 ? ey - 7 : ey + 12}" text-anchor="${ex > W / 2 ? 'end' : 'start'}" class="bm-label bm-switch-label">Z switch (${ax.endstop_x.toFixed(1)}, ${ax.endstop_y.toFixed(1)})</text>`;
  }
  if (pos) {
    const [cx, cy] = to(pos[0], pos[1]);
    html += `<circle cx="${cx}" cy="${cy}" r="4" class="bm-nozzle"/>
      <text x="${cx + 7}" y="${cy + 4}" class="bm-label bm-nozzle-label">(${pos[0].toFixed(1)}, ${pos[1].toFixed(1)})</text>`;
  }
  setHTML(svg, html);
}

function renderBusy() {
  const connected = S.online && !!S.status;
  const busy = S.busy;
  document.querySelectorAll('.jog[data-jog], #tool-tabs button, #tool-select, .machine-btn').forEach(b => { b.disabled = !connected || busy; });
  $('capture').disabled = !connected || busy || activeTool() < 0 || !S.status.pos;
  Vision.renderEligibility();
}

function renderView() {
  const v = S.view;
  $('crosshair-enabled').checked = v.crosshair;
  setText('zoom-label', Math.round(v.zoom * 100) + '%');
  $('flip-h').setAttribute('aria-pressed', v.flipH);
  $('flip-v').setAttribute('aria-pressed', v.flipV);
  setText('rotate-label', (v.rotate || 0) + '°');
  $('contrast').value = v.contrast;
  setText('cam-name', S.camera ? S.camera.name : '—');
  CameraView.applyView();
}

// ------------------------------------------------------------------ actions
function consoleLog(line, kind = '') {
  const log = $('console-log');
  const div = document.createElement('div');
  div.textContent = line;
  if (kind) div.className = 'log-' + kind;
  log.appendChild(div);
  while (log.childNodes.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

async function run(script, label) {
  try {
    await Printer.gcode(script);
    return true;
  } catch (e) {
    notice((label || 'Command') + ' failed: ' + e.message, 'error');
    consoleLog('! ' + e.message, 'error');
    return false;
  } finally {
    poll();
  }
}

async function toolChange(n) {
  if (n === activeTool()) return;
  const ax = !!(S.status && S.status.axiscope);
  const lines = [];
  if (ax) lines.push('AXISCOPE_BEFORE_PICKUP_GCODE');
  lines.push('T' + n);
  if (ax) lines.push('AXISCOPE_AFTER_PICKUP_GCODE');
  if (S.ref) {
    // Bring the new tool to the camera: its own captured spot if it has one.
    let { x, y } = S.ref;
    if (n !== 0 && S.grabs[n]) ({ x, y } = S.grabs[n]);
    lines.push('SAVE_GCODE_STATE NAME=RESTORE_POS', 'G90',
      'G0 Z' + S.ref.z.toFixed(3) + ' F3000',
      'G0 X' + x.toFixed(3) + ' Y' + y.toFixed(3) + ' F12000',
      'RESTORE_GCODE_STATE NAME=RESTORE_POS');
  }
  notice('Changing to T' + n + '…');
  if (await run(lines.join('\n'), 'Tool change')) notice('T' + n + ' is active.' + (S.ref ? '' : ' Capture T0 to have tools return to the camera.'));
}

function jog(axis, dir) {
  const v = S.step * dir;
  if (axis === 'Z') {
    return run(`SAVE_GCODE_STATE NAME=axiscope_jog\nG91\nG0 Z${v.toFixed(3)} F600\nRESTORE_GCODE_STATE NAME=axiscope_jog`, 'Jog');
  }
  // XY "bounce" move from the original Axiscope: overshoot by 0.5 mm and come
  // back, so the final approach always takes up belt/backlash slack.
  const bounce = v > 0 ? v + 0.5 : v - 0.5, back = v > 0 ? -0.5 : 0.5;
  const f = Math.abs(v) > 1 ? 3000 : 500;
  return run(`SAVE_GCODE_STATE NAME=bounce_move\nG91\nG0 ${axis}${bounce.toFixed(3)} F${f}\nG0 ${axis}${back.toFixed(3)} F${f}\nRESTORE_GCODE_STATE NAME=bounce_move`, 'Jog');
}

function capture() {
  const tn = activeTool();
  const p = S.status && S.status.pos;
  if (tn < 0 || !p || S.busy) return;
  if (tn === 0) {
    S.ref = { x: +p[0].toFixed(3), y: +p[1].toFixed(3), z: +p[2].toFixed(3) };
    notice('Reference captured at X ' + S.ref.x.toFixed(3) + ' Y ' + S.ref.y.toFixed(3) + '. Select another tool to continue.');
  } else {
    const off = S.status.offsets[tn] || { x: 0, y: 0 };
    S.grabs[tn] = { x: +p[0].toFixed(3), y: +p[1].toFixed(3), ox: off.x, oy: off.y };
    delete S.saved[tn];
    notice(S.ref ? 'T' + tn + ' offset captured. Select another tool to continue.' : 'T' + tn + ' position captured. Capture T0 to calculate its offset.');
  }
  saveCaptures();
  renderedTools = '';
  renderAll();
}

async function saveConfig() {
  const tools = S.status.tools.filter(n => n !== 0 && newOffset(n));
  const btn = $('save-config');
  btn.disabled = true;
  let ok = 0;
  for (const n of tools) {
    const o = newOffset(n), z = zOffset(n);
    const vals = [o.x, o.y].concat(z ? [z.z_offset] : []).map(v => v.toFixed(3));
    const name = toolName(n).replace(/"/g, '');
    if (await run(`AXISCOPE_SAVE_TOOL_OFFSET TOOL_NAME="${name}" OFFSETS="[${vals.join(', ')}]"`, 'Saving T' + n)) {
      S.saved[n] = true;
      ok++;
    } else break;
  }
  saveCaptures();
  if (ok === tools.length) notice(`Saved ${ok} tool offset${ok === 1 ? '' : 's'}. Run FIRMWARE_RESTART to load them.`);
  renderAll();
}

// ---------------------------------------------------------------------- LED
let ledDial;
function initLed() {
  const send = debounce(() => {
    const t = S.led.template.trim();
    if (!t || !S.online) return;
    const duty = S.led.enabled ? S.led.pwm : 0;
    run(t.replace(/\{value\}/g, (duty / 100).toFixed(3)).replace(/\{percent\}/g, String(duty)), 'LED');
  }, 150);
  const render = () => {
    const duty = S.led.enabled ? S.led.pwm : 0;
    setText('camera-control-summary', S.led.template.trim() ? 'LED ' + duty + '%' : 'NOT SET UP');
    setText('led-duty', `PWM ${duty}% · duty ${(duty / 100).toFixed(2)}`);
    $('pwm-meter').style.width = duty + '%';
    $('led-enabled').checked = S.led.enabled;
    $('led-fieldset').disabled = !S.led.enabled;
    $('led-enabled').disabled = !S.led.template.trim();
    setText('led-note', S.led.template.trim()
      ? 'Sends: ' + S.led.template.trim()
      : 'Set an LED command in Setup to drive your camera LED from here.');
    LS.set('led', S.led);
  };
  ledDial = buildDial(document.querySelector('[data-dial="led-pwm"]'),
    { id: 'led-pwm', label: 'LED PWM / brightness', min: 0, max: 100, value: S.led.pwm, unit: '%' },
    v => { S.led.pwm = v; render(); send(); });
  $('led-enabled').addEventListener('change', e => { S.led.enabled = e.target.checked; render(); send(); });
  $('reset-camera-controls').addEventListener('click', () => { S.led.enabled = false; S.led.pwm = 60; ledDial.set(60); render(); send(); });
  $('led-template').value = S.led.template;
  $('led-template').addEventListener('input', e => { S.led.template = e.target.value; render(); });
  render();
}

// --------------------------------------------------------------------- init
function initIncrements() {
  const steps = [0.01, 0.05, 0.1, 0.5, 1, 10];
  if (!steps.includes(S.step)) S.step = 0.1;
  const render = () => {
    setHTML('increments', steps.map(s => `<button type="button" data-step="${s}" class="${s === S.step ? 'selected' : ''}" aria-pressed="${s === S.step}">${s}</button>`).join(''));
  };
  $('increments').addEventListener('click', e => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    S.step = Number(b.dataset.step);
    LS.set('step', S.step);
    render();
  });
  render();
}

function initEvents() {
  document.querySelectorAll('nav [data-tab]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.tab)));
  $('brand').addEventListener('click', () => navigate('calibration'));
  document.addEventListener('click', e => {
    const go = e.target.closest('[data-goto]');
    if (go) navigate(go.dataset.goto);
    const card = e.target.closest('[data-offset-tool]');
    if (card) {
      const n = Number(card.dataset.offsetTool);
      navigate('calibration');
      if (n !== activeTool()) notice('Select T' + n + ' in Tool alignment to change to it.');
    }
    if (e.target.closest('#review')) navigate('offsets');
  });

  $('conn-form').addEventListener('submit', e => { e.preventDefault(); connect($('printer-ip').value); });
  $('disconnect-btn').addEventListener('click', disconnect);
  $('camera-retry').addEventListener('click', () => { if (S.camera) { CameraView.setStream(S.camera.stream); Vision.resetBackoff(); } });
  $('manual-cam-form').addEventListener('submit', addManualCamera);

  $('tool-tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tool]');
    if (b) toolChange(Number(b.dataset.tool));
  });
  $('tool-select').addEventListener('change', e => toolChange(Number(e.target.value)));
  document.querySelectorAll('.jog[data-jog]').forEach(b => b.addEventListener('click', () => jog(b.dataset.jog, Number(b.dataset.dir))));
  $('capture').addEventListener('click', capture);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || S.tab !== 'calibration' || e.repeat) return;
    if (e.target.closest('input, textarea, select, button, summary, a')) return;
    e.preventDefault();
    capture();
  });

  $('btn-home').addEventListener('click', () => run('G28', 'Homing'));
  $('btn-qgl').addEventListener('click', () => run('QUAD_GANTRY_LEVEL', 'QGL'));
  $('btn-motors').addEventListener('click', () => run('M84', 'Motors off'));

  $('crosshair-enabled').addEventListener('change', e => { S.view.crosshair = e.target.checked; LS.set('view', S.view); renderView(); });
  $('flip-h').addEventListener('click', () => { S.view.flipH = !S.view.flipH; LS.set('view', S.view); saveOrientation(); renderView(); });
  $('flip-v').addEventListener('click', () => { S.view.flipV = !S.view.flipV; LS.set('view', S.view); saveOrientation(); renderView(); });
  $('rotate-view').addEventListener('click', () => { S.view.rotate = ((S.view.rotate || 0) + 90) % 360; LS.set('view', S.view); saveOrientation(); renderView(); });
  $('contrast').addEventListener('input', e => { S.view.contrast = Number(e.target.value); LS.set('view', S.view); CameraView.applyView(); });
  const zoomBy = d => {
    const i = ZOOM_STEPS.findIndex(z => z >= S.view.zoom - 1e-6);
    S.view.zoom = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (i < 0 ? 0 : i) + d))];
    LS.set('view', S.view);
    renderView();
  };
  $('zoom-in').addEventListener('click', () => zoomBy(1));
  $('zoom-out').addEventListener('click', () => zoomBy(-1));
  $('reset-view').addEventListener('click', () => { Object.assign(S.view, { zoom: 1, crosshair: true, contrast: 100 }); LS.set('view', S.view); renderView(); });

  $('console-form').addEventListener('submit', async e => {
    e.preventDefault();
    const cmd = $('gcode-input').value.trim();
    if (!cmd || !S.host) return;
    $('gcode-input').value = '';
    consoleLog('> ' + cmd, 'cmd');
    if (await run(cmd, cmd.split(/\s/)[0])) consoleLog('ok', 'ok');
  });

  $('copy-config').addEventListener('click', async () => {
    try { await copyText(configText()); notice('Configuration copied to the clipboard.'); }
    catch (e) { notice(e.message, 'error'); }
  });
  $('save-config').addEventListener('click', saveConfig);
  $('calibrate-z').addEventListener('click', async () => {
    notice('Z offset calibration started; results update on the cards as each tool finishes.');
    if (await run('CALIBRATE_ALL_Z_OFFSETS', 'Z calibration')) notice('Z offset calibration finished.');
  });
  $('set-endstop').addEventListener('click', async () => {
    if (await run('AXISCOPE_SET_ENDSTOP_POSITION CURRENT=1', 'Set endstop')) notice('Z switch position set to the current toolhead position.');
  });
}

function init() {
  hydrateIcons();
  initTheme();
  CameraView.init(S.view);
  CameraView.onFeedState = state => {
    const labels = { none: 'NO FEED', connecting: 'CONNECTING', live: 'LIVE FEED', error: 'FEED ERROR' };
    setText('feed-label', labels[state] + (state === 'live' && CameraView.frame ? ' · ' + CameraView.frame.width + '×' + CameraView.frame.height : ''));
    $('feed-label-wrap').dataset.state = state;
    const failed = state === 'error' && S.camera;
    setText('camera-empty-text', failed ? 'The camera stream could not be loaded from' : 'No camera connected');
    setText('camera-empty-url', failed ? S.camera.stream : '');
    $('camera-empty-url').hidden = !failed;
    $('camera-retry').hidden = !failed;
    $('camera-empty').hidden = state === 'live' || state === 'connecting';
  };
  initIncrements();
  initLed();
  initEvents();
  Vision.init();
  renderView();
  renderAll();

  $('printer-ip').value = S.host || window.location.hostname;
  // Try the saved printer, else the host this page is served from (Axiscope
  // usually runs on the printer itself). Fall back to Setup if neither answers.
  const guess = S.host || window.location.hostname;
  if (guess) {
    navigate('setup');
    setText('conn-status', 'Looking for your printer…');
    connect(guess, { auto: true }).then(ok => {
      if (ok && S.camera) return;
      if (!ok) notice('Enter your printer’s address to begin.');
      else notice('Connected. Select the nozzle camera to continue.');
    });
  } else {
    navigate('setup');
    notice('Connect to your printer to begin.');
  }
}

document.addEventListener('DOMContentLoaded', init);
