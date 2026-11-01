// Moonraker access. GET requests only, so no CORS preflight is needed
// (same as the original Axiscope UI).
const Printer = {
  host: '',

  url(path) {
    return 'http://' + this.host.replace(/^https?:\/\//, '').replace(/\/+$/, '') + path;
  },

  async get(path, timeout = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(this.url(path), { signal: ctrl.signal, cache: 'no-store' });
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
      if (!res.ok) {
        const msg = body && body.error ? (body.error.message || body.error) : res.status + ' ' + res.statusText;
        throw new Error(msg);
      }
      return body;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Moonraker did not answer in time');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },

  // Resolves once Klipper has run the whole script; rejects with Klipper's error.
  gcode(script, timeout = 120000) {
    return this.get('/printer/gcode/script?script=' + encodeURIComponent(script), timeout);
  },

  query(objects) {
    return this.get('/printer/objects/query?' + objects.map(encodeURIComponent).join('&'), 5000)
      .then(r => r.result.status);
  },

  info() { return this.get('/server/info', 5000).then(r => r.result); },

  // Check whether Moonraker answers at `host` without switching to it.
  async probe(host, timeout = 3000) {
    const prev = this.host;
    this.host = host;
    const p = this.get('/server/info', timeout);
    this.host = prev;
    const r = await p;
    if (!r || !r.result || !('klippy_state' in r.result)) throw new Error('not a Moonraker server');
    return r.result;
  },

  webcams() { return this.get('/server/webcams/list', 5000).then(r => r.result.webcams || []); },

  // Host name without any port, e.g. "voron.local".
  hostname() {
    return this.host.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  },

  // Where the web UI (nginx) lives: camera proxy paths like /webcam2/ are
  // served there, not by Moonraker's own port 7125.
  webHost() {
    return this.host.replace(/^https?:\/\//, '').replace(/:7125$/, '');
  },

  // Camera URLs from Moonraker can be absolute (often with a host name the
  // browser can't resolve) or relative. Absolute: keep port + path, swap in
  // the printer's host name. Relative: resolve against the web UI.
  resolveCameraUrl(u) {
    if (/^[a-z]+:\/\//i.test(u)) {
      try {
        const p = new URL(u);
        return 'http://' + this.hostname() + (p.port ? ':' + p.port : '') + p.pathname + p.search;
      } catch (e) { /* fall through */ }
    }
    return 'http://' + this.webHost() + (u.startsWith('/') ? u : '/' + u);
  },

  cameraUrls(cam) {
    const stream = this.resolveCameraUrl(cam.stream_url || '/webcam/?action=stream');
    const snapshot = cam.snapshot_url ? this.resolveCameraUrl(cam.snapshot_url) : null;
    return mjpegUrls(stream, snapshot);
  },

  // [cam ...] sections of crowsnest.conf, read through Moonraker's file API.
  // Cameras configured only in crowsnest never appear in the webcam list.
  async crowsnestCams() {
    let text;
    try {
      const res = await fetch(this.url('/server/files/config/crowsnest.conf'), { cache: 'no-store' });
      if (!res.ok) return [];
      text = await res.text();
    } catch (e) {
      return [];
    }
    const cams = [];
    let cur = null;
    text.split(/\r?\n/).forEach(raw => {
      const line = raw.replace(/\s[#;].*$/, '').replace(/^[#;].*$/, '').trim();
      if (!line) return;
      const sec = line.match(/^\[\s*cam\s+([^\]]+?)\s*\]$/i);
      if (sec) { cur = { name: sec[1] }; cams.push(cur); return; }
      if (line.startsWith('[')) { cur = null; return; }
      const kv = line.match(/^([\w-]+)\s*[:=]\s*(.*)$/);
      if (cur && kv) cur[kv[1].toLowerCase()] = kv[2].trim();
    });
    return cams.map((c, i) => Object.assign(c, { port: Number(c.port) || 8080 + i }));
  },

  // Candidate URLs for a crowsnest camera: the nginx proxy path that the
  // standard Mainsail/Fluidd setup maps to its port (8080 -> /webcam/,
  // 8081 -> /webcam2/, ...), then the streamer's port directly (no_proxy).
  crowsnestUrls(cam) {
    const bases = [];
    const idx = cam.port - 8080;
    if (idx >= 0 && idx < 4) bases.push(['http://' + this.webHost() + '/webcam' + (idx ? idx + 1 : '') + '/', 'proxy']);
    bases.push(['http://' + this.hostname() + ':' + cam.port + '/', 'port ' + cam.port]);
    // ustreamer speaks ?action=...; camera-streamer has /stream and /snapshot.
    const native = /camera-streamer/i.test(cam.mode || '');
    const forms = native
      ? [['stream', 'snapshot'], ['?action=stream', '?action=snapshot']]
      : [['?action=stream', '?action=snapshot']];
    const out = [];
    bases.forEach(([base, via]) => forms.forEach(([st, sn]) => out.push({ stream: base + st, snapshot: base + sn, via })));
    return out;
  },

  // Image loads work cross-origin without CORS, so they can test a snapshot URL.
  probeImage(url, timeout = 4000) {
    return new Promise(resolve => {
      const img = new Image();
      const done = ok => { clearTimeout(t); img.onload = img.onerror = null; resolve(ok); };
      const t = setTimeout(() => done(false), timeout);
      img.onload = () => done(img.naturalWidth > 0);
      img.onerror = () => done(false);
      img.src = url + (url.includes('?') ? '&' : '?') + '_probe=' + Date.now();
    });
  },
};

// Axiscope's own backend (same origin as this page).
const Api = {
  async call(path, body) {
    const opts = body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    const res = await fetch(path, Object.assign({ cache: 'no-store' }, opts));
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) throw new Error((data && data.error) || res.status + ' ' + res.statusText);
    return data;
  },
  status() { return this.call('/api/status'); },
  detect(body) { return this.call('/api/detect', body); },
  alignStart(body) { return this.call('/api/align/start', body); },
  alignStatus() { return this.call('/api/align/status'); },
  alignCancel() { return this.call('/api/align/cancel', {}); },
  alignRevert() { return this.call('/api/align/revert', {}); },
};

// The camera view and detection need MJPEG + single JPEG frames. WebRTC
// services list a player page instead, so map them to their MJPEG endpoints:
//   go2rtc (often port 1984):  .../stream.html?src=X  -> .../api/stream.mjpeg?src=X
//                              snapshot                -> .../api/frame.jpeg?src=X
//   camera-streamer WebRTC:    .../webrtc              -> .../stream, .../snapshot
//   ustreamer / mjpg-streamer: ...?action=stream       -> ...?action=snapshot
// Returns {stream, snapshot, kind}; snapshot is null if it can't be derived.
function mjpegUrls(stream, snapshot) {
  let u;
  try { u = new URL(stream); } catch (e) { return { stream, snapshot, kind: 'unknown' }; }
  const src = u.searchParams.get('src');
  const base = u.origin + u.pathname.replace(/[^/]*$/, '');   // directory of the page
  if (src && (/\.html$/.test(u.pathname) || /\/api\/(stream\.mjpeg|ws|webrtc)$/.test(u.pathname) || u.port === '1984')) {
    const root = base.replace(/api\/$/, '');
    const q = '?src=' + encodeURIComponent(src);
    return { stream: root + 'api/stream.mjpeg' + q, snapshot: root + 'api/frame.jpeg' + q, kind: 'go2rtc' };
  }
  if (/\/webrtc\/?$/.test(u.pathname)) {
    const root = u.origin + u.pathname.replace(/webrtc\/?$/, '');
    return { stream: root + 'stream', snapshot: snapshot || root + 'snapshot', kind: 'camera-streamer' };
  }
  if (/action=stream/.test(stream)) {
    return { stream, snapshot: snapshot || stream.replace('action=stream', 'action=snapshot'), kind: 'mjpeg' };
  }
  if (/\/stream(\.mjpeg)?$/.test(u.pathname)) {
    return { stream, snapshot: snapshot || stream.replace(/\/stream(\.mjpeg)?(\?|$)/, '/snapshot$2'), kind: 'mjpeg' };
  }
  return { stream, snapshot, kind: 'unknown' };
}
