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

  // Camera URLs from Moonraker can be absolute (another host name) or
  // relative; always serve them through the printer address we reached.
  cameraUrls(cam) {
    const pathOf = u => {
      try { const p = new URL(u); return p.pathname + p.search; } catch (e) { return u; }
    };
    const stream = this.url(pathOf(cam.stream_url || '/webcam/?action=stream'));
    const snapshot = cam.snapshot_url
      ? this.url(pathOf(cam.snapshot_url))
      : stream.replace('action=stream', 'action=snapshot');
    return { stream, snapshot };
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
