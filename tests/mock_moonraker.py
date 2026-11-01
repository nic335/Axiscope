"""
Mock Moonraker + nozzle camera for developing Axiscope without a printer.

    python tests/mock_moonraker.py            # Moonraker on :7125
    python app.py                             # Axiscope on :3000
    open http://localhost:3000 and connect to localhost:7125

The simulated toolchanger has tools whose configured offsets are wrong by a
known amount (TRUE_OFFSETS), so a correct calibration recovers TRUE_OFFSETS.
"""
import math
import os
import re
import sys
import threading
import time

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request

sys.path.insert(0, os.path.dirname(__file__))
from synthetic import render_nozzle  # noqa: E402

CONFIG_OFFSETS = {0: (0.0, 0.0), 1: (0.10, -0.10), 2: (-0.20, 0.05), 3: (0.0, 0.0)}
TRUE_OFFSETS = {0: (0.0, 0.0), 1: (0.35, -0.42), 2: (-0.48, 0.27), 3: (0.21, 0.18)}
CAMERA_XY = (150.0, 150.0)
PX_PER_MM, MIRROR = 380.0, True
ANGLE = math.radians(float(os.environ.get("MOCK_ANGLE", 7.0)))  # camera rotation; 90 = side-mounted
W, H = 1280, 720
CAM_PORT = int(os.environ.get("CAM_PORT", 18080))  # streamer ports: CAM_PORT, CAM_PORT+1

app = Flask(__name__)
lock = threading.Lock()
state = {
    "machine": [0.0, 0.0, 0.0], "homed": "", "relative": False, "saved": {},
    "tool": 0, "qgl": False, "motors": False, "saved_offsets": {},
}


def gcode_pos():
    off = CONFIG_OFFSETS.get(state["tool"], (0, 0))
    m = state["machine"]
    return [m[0] - off[0], m[1] - off[1], m[2]]


def set_gcode_pos(axis, value):
    i = "XYZ".index(axis)
    off = CONFIG_OFFSETS.get(state["tool"], (0, 0)) + (0,)
    state["machine"][i] = value + off[i]


def nozzle_px():
    true = TRUE_OFFSETS[state["tool"]]
    phys = np.array(state["machine"][:2]) - np.array(true)
    rot = np.array([[math.cos(ANGLE), -math.sin(ANGLE)], [math.sin(ANGLE), math.cos(ANGLE)]])
    A = PX_PER_MM * rot @ (np.diag([1, -1]) if MIRROR else np.eye(2))
    return np.array([W / 2, H / 2]) + A @ (phys - np.array(CAMERA_XY))


def run_line(line):
    line = line.split(";")[0].strip()
    if not line:
        return
    cmd = line.split()[0].upper()
    args = dict((k.upper(), v) for k, v in re.findall(r"([A-Za-z_]+)=?(\"[^\"]*\"|\S+)", line)[1:])
    if cmd == "G28":
        state["homed"] = "xyz"
        state["machine"] = [150.25 + TRUE_OFFSETS[state["tool"]][0], 149.8 + TRUE_OFFSETS[state["tool"]][1], 10.0]
        state["motors"] = True
    elif cmd == "G90":
        state["relative"] = False
    elif cmd == "G91":
        state["relative"] = True
    elif cmd in ("G0", "G1"):
        if not state["homed"]:
            raise ValueError("Must home axis first")
        for axis, val in re.findall(r"([XYZ])(-?[\d.]+)", line.upper()):
            v = float(val)
            if state["relative"]:
                state["machine"]["XYZ".index(axis)] += v
            else:
                set_gcode_pos(axis, v)
        time.sleep(0.05)
    elif cmd == "SAVE_GCODE_STATE":
        state["saved"][args.get("NAME", "default")] = state["relative"]
    elif cmd == "RESTORE_GCODE_STATE":
        state["relative"] = state["saved"].get(args.get("NAME", "default"), False)
    elif re.fullmatch(r"T\d+", cmd):
        n = int(cmd[1:])
        if n not in CONFIG_OFFSETS:
            raise ValueError("Unknown tool %d" % n)
        gp = gcode_pos()
        state["tool"] = n
        # The toolchanger keeps the gcode position; the carriage moves by the offset change.
        for i, a in enumerate("XY"):
            set_gcode_pos(a, gp[i])
        time.sleep(0.3)
    elif cmd == "QUAD_GANTRY_LEVEL":
        state["qgl"] = True
    elif cmd == "M84":
        state["motors"] = False
        state["homed"] = ""
    elif cmd == "AXISCOPE_SAVE_TOOL_OFFSET":
        state["saved_offsets"][args["TOOL_NAME"].strip('"')] = args["OFFSETS"].strip('"')
    elif cmd in ("M400", "AXISCOPE_BEFORE_PICKUP_GCODE", "AXISCOPE_AFTER_PICKUP_GCODE",
                 "SET_PIN", "M118", "CALIBRATE_ALL_Z_OFFSETS", "AXISCOPE_SET_ENDSTOP_POSITION"):
        pass
    else:
        raise ValueError("Unknown command: %s" % cmd)


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/server/info")
def info():
    return jsonify(result={"klippy_connected": True, "klippy_state": "ready"})


@app.route("/server/webcams/list")
def webcams():
    # Only the first camera is registered in the web UI; the others exist
    # only in crowsnest.conf (see CROWSNEST_CONF), like on many printers.
    return jsonify(result={"webcams": [{
        "name": "nozzle_cam", "service": "mjpegstreamer-adaptive",
        "stream_url": "http://localhost:%d/?action=stream" % CAM_PORT,
        "snapshot_url": "http://localhost:%d/?action=snapshot" % CAM_PORT,
        "flip_horizontal": False, "flip_vertical": False}, {
        # A go2rtc WebRTC camera, listed with its player page like Mainsail does.
        "name": "chamber_go2rtc", "service": "webrtc-go2rtc",
        "stream_url": "http://localhost:%d/stream.html?src=chamber" % (CAM_PORT + 1),
        "snapshot_url": "", "flip_horizontal": False, "flip_vertical": False}]})


CROWSNEST_CONF = ("""[crowsnest]
log_path: ~/printer_data/logs/crowsnest.log

[cam nozzle_cam]
mode: ustreamer                  # duplicate of the webcam list entry
port: {0}
device: /dev/video0
resolution: 1280x720

[cam side_cam]
mode: ustreamer
port: {1}                      # served directly by this mock
resolution: 1280x720

[cam bed_cam]
mode: camera-streamer
port: {2}                      # nothing listens here: shows as unreachable
""").format(CAM_PORT, CAM_PORT + 1, CAM_PORT + 2)


@app.route("/server/files/config/crowsnest.conf")
def crowsnest_conf():
    return Response(CROWSNEST_CONF, mimetype="text/plain")


@app.route("/printer/gcode/script", methods=["GET", "POST"])
def script():
    s = request.args.get("script") or (request.get_json(silent=True) or {}).get("script", "")
    with lock:
        try:
            for line in s.split("\n"):
                run_line(line)
        except ValueError as e:
            return jsonify(error={"code": 400, "message": str(e)}), 400
    return jsonify(result="ok")


@app.route("/printer/objects/query")
def query():
    names = list(request.args.keys())
    with lock:
        st = {
            "gcode_move": {"gcode_position": gcode_pos(), "position": list(state["machine"])},
            "toolhead": {"homed_axes": state["homed"], "axis_minimum": [0, -20, 0, 0], "axis_maximum": [300, 300, 280, 0]},
            "toolchanger": {"tool_number": state["tool"], "tool_numbers": list(CONFIG_OFFSETS),
                            "tool_names": ["tool T%d" % n for n in CONFIG_OFFSETS]},
            "quad_gantry_level": {"applied": state["qgl"]},
            "stepper_enable": {"steppers": {"stepper_x": state["motors"]}},
            "axiscope": {"probe_results": {}, "can_save_config": True,
                         "endstop_x": 226.7, "endstop_y": -18.4, "endstop_z": 7.8},
        }
        for n, (x, y) in CONFIG_OFFSETS.items():
            st["tool T%d" % n] = {"tool_number": n, "gcode_x_offset": x, "gcode_y_offset": y, "gcode_z_offset": 0.0}
    return jsonify(result={"status": {k: v for k, v in st.items() if k in names}})


DECOY = os.environ.get("MOCK_DECOY") == "1"   # a fixed, stronger concentric target in view


def jpeg():
    with lock:
        x, y = nozzle_px()
    img = render_nozzle(x, y, W, H, noise=5, seed=int(time.time() * 1000) % 100000)
    if DECOY:
        for r, v in ((70, 230), (52, 20), (36, 230), (22, 20), (10, 230)):
            cv2.circle(img, (1100, 150), r, (v, v, v), -1, cv2.LINE_AA)
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()


def side_jpeg():
    img = np.full((H, W, 3), 38, np.uint8)
    cv2.putText(img, "side_cam (crowsnest only)", (60, H // 2), cv2.FONT_HERSHEY_SIMPLEX, 2, (190, 220, 160), 3)
    return cv2.imencode(".jpg", img)[1].tobytes()


def streamer(make_frame):
    """A ustreamer-like app: /?action=snapshot and /?action=stream."""
    cam = Flask("cam")

    @cam.route("/")
    @cam.route("/webcam/")
    @cam.route("/api/frame.jpeg")         # go2rtc snapshot
    @cam.route("/api/stream.mjpeg")       # go2rtc MJPEG
    def index():
        if request.args.get("action") == "snapshot" or request.path.endswith("frame.jpeg"):
            return Response(make_frame(), mimetype="image/jpeg")

        def stream():
            while True:
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + make_frame() + b"\r\n"
                time.sleep(0.1)
        return Response(stream(), mimetype="multipart/x-mixed-replace; boundary=frame")
    return cam


app.add_url_rule("/webcam/", "webcam", streamer(jpeg).view_functions["index"])


@app.route("/_mock/state")
def mock_state():
    return jsonify(tool=state["tool"], gcode=gcode_pos(), saved=state["saved_offsets"], true=TRUE_OFFSETS,
                   nozzle_px=[float(v) for v in nozzle_px()])


if __name__ == "__main__":
    from werkzeug.serving import make_server
    for port, frame in ((CAM_PORT, jpeg), (CAM_PORT + 1, side_jpeg)):
        threading.Thread(target=make_server("0.0.0.0", port, streamer(frame), threaded=True).serve_forever,
                         daemon=True).start()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 7125)), threaded=True)
