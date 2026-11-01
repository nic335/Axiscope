"""Moonraker printer access and webcam snapshot capture (stdlib HTTP only)."""
import json
import re
import urllib.parse
import urllib.request

import numpy as np

from .detect import decode_image


class HardwareError(RuntimeError):
    pass


def _base_url(host):
    host = (host or "").strip()
    if not host:
        raise HardwareError("No printer address given.")
    if not re.match(r"^https?://", host):
        host = "http://" + host
    return host.rstrip("/")


def snapshot_url(url):
    """Turn an MJPEG stream URL into its single-frame snapshot URL."""
    return url.replace("action=stream", "action=snapshot")


class SnapshotCamera:
    """Grabs single JPEG frames from a crowsnest/ustreamer snapshot URL."""

    def __init__(self, url, timeout=5.0):
        url = snapshot_url((url or "").strip())
        if urllib.parse.urlparse(url).scheme not in ("http", "https"):
            raise HardwareError("Camera snapshot URL must be http(s).")
        self.url = url
        self.timeout = timeout

    def frame(self):
        # Cache-buster: some proxies return the previous frame otherwise.
        sep = "&" if "?" in self.url else "?"
        url = "%s%s_ts=%d" % (self.url, sep, np.random.randint(1 << 30))
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as resp:
                data = resp.read()
        except OSError as e:
            raise HardwareError("Camera snapshot failed: %s" % e)
        img = decode_image(data)
        if img is None:
            raise HardwareError("Camera returned an image OpenCV cannot decode.")
        return img


class MoonrakerPrinter:
    """The small subset of Moonraker needed for alignment moves."""

    STATE = "AXISCOPE_AUTOALIGN"

    def __init__(self, host, timeout=60.0):
        self.base = _base_url(host)
        self.timeout = timeout

    def _request(self, path, body=None, timeout=None):
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            try:
                detail = json.loads(detail)["error"]["message"]
            except (ValueError, KeyError, TypeError):
                pass
            raise HardwareError("Moonraker error: %s" % detail)
        except OSError as e:
            raise HardwareError("Cannot reach Moonraker at %s: %s" % (self.base, e))

    def gcode(self, script):
        # Moonraker answers once Klipper has executed the whole script.
        return self._request("/printer/gcode/script", {"script": script})

    def query(self, *objects):
        q = "&".join(urllib.parse.quote(o) for o in objects)
        res = self._request("/printer/objects/query?" + q, timeout=10)
        return res["result"]["status"]

    def position(self):
        return list(self.query("gcode_move")["gcode_move"]["gcode_position"][:3])

    def homed_axes(self):
        return self.query("toolhead")["toolhead"].get("homed_axes", "")

    def _move(self, mode, x, y, feed, approach):
        """Move with an optional backlash approach: the final segment of every
        move travels +approach on both axes, so the nozzle is always parked
        from the same direction."""
        f = int(feed * 60)
        lines = ["SAVE_GCODE_STATE NAME=%s" % self.STATE]
        if mode == "rel":
            lines.append("G91")
            if approach > 0:
                lines.append("G0 X%.4f Y%.4f F%d" % (x - approach, y - approach, f))
                lines.append("G0 X%.4f Y%.4f F%d" % (approach, approach, f))
            else:
                lines.append("G0 X%.4f Y%.4f F%d" % (x, y, f))
        else:
            lines.append("G90")
            if approach > 0:
                lines.append("G0 X%.4f Y%.4f F%d" % (x - approach, y - approach, f))
            lines.append("G0 X%.4f Y%.4f F%d" % (x, y, f))
        lines += ["RESTORE_GCODE_STATE NAME=%s" % self.STATE, "M400"]
        self.gcode("\n".join(lines))

    def move_relative(self, dx, dy, feed, approach):
        self._move("rel", dx, dy, feed, approach)

    def move_absolute(self, x, y, feed, approach):
        self._move("abs", x, y, feed, approach)
