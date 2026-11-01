import base64
import os
import threading

from flask.app import Flask
from flask.globals import request
from flask.helpers import send_from_directory
from flask.json import jsonify
from flask.wrappers import Response

try:
    import cv2
    from axiscope_vision.align import AlignError, AutoAligner, MappingStore, describe_mapping
    from axiscope_vision.detect import PIPELINE_STAGES, detect, pipeline_view
    from axiscope_vision.hardware import HardwareError, MoonrakerPrinter, SnapshotCamera
    VISION_ERROR = None
except ImportError as e:  # the manual UI keeps working without OpenCV
    cv2 = None
    VISION_ERROR = str(e)

app = Flask(__name__)

# Learned camera mappings live outside the git checkout, so Moonraker's
# update manager never sees a dirty repo.
DATA_DIR = os.path.expanduser(os.environ.get('AXISCOPE_DATA', '~/.config/axiscope'))
MAPPINGS = MappingStore(os.path.join(DATA_DIR, 'mappings.json')) if VISION_ERROR is None else None

_job_lock = threading.Lock()
_job = None


@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')


@app.route('/<path:path>')
def serve_files(path):
    return send_from_directory('.', path)


@app.after_request
def _no_stale_ui(resp):
    # Browsers otherwise cache index.html/JS heuristically and keep running an
    # old UI after an update. no-cache still allows cheap 304 revalidation.
    resp.headers['Cache-Control'] = 'no-cache'
    return resp


def _error(message, status=400):
    return jsonify({'error': message}), status


def _vision_required():
    if VISION_ERROR:
        return _error('OpenCV is not installed on the Axiscope host (%s). '
                      'Re-run install.sh or pip install opencv-python-headless numpy.'
                      % VISION_ERROR, 503)
    return None


@app.route('/api/status')
def api_status():
    with _job_lock:
        job = _job.snapshot() if _job else None
    return jsonify({
        'opencv': VISION_ERROR is None,
        'opencv_version': cv2.__version__ if cv2 else None,
        'error': VISION_ERROR,
        'align': job,
    })


@app.route('/api/detect', methods=['POST'])
def api_detect():
    err = _vision_required()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    try:
        img = SnapshotCamera(body.get('camera_url')).frame()
    except HardwareError as e:
        return _error(str(e), 502)
    hint = body.get('hint')
    lock = body.get('lock') if isinstance(body.get('lock'), dict) else None
    res = detect(img, body.get('params'), hint=tuple(hint) if hint else None,
                 want_edges=bool(body.get('edges')), lock=lock)
    if res.get('edges_jpeg') is not None:
        res['edges'] = 'data:image/jpeg;base64,' + base64.b64encode(res.pop('edges_jpeg')).decode()
    res.pop('edges_jpeg', None)
    return jsonify(res)


@app.route('/api/vision/frame', methods=['POST'])
def api_vision_frame():
    """One JPEG of a detection pipeline stage, for watching the tuning live."""
    err = _vision_required()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    stage = body.get('stage', 'edges')
    if stage not in PIPELINE_STAGES:
        return _error('stage must be one of: ' + ', '.join(PIPELINE_STAGES))
    try:
        img = SnapshotCamera(body.get('camera_url')).frame()
    except HardwareError as e:
        return _error(str(e), 502)
    lock = body.get('lock') if isinstance(body.get('lock'), dict) else None
    view = pipeline_view(img, body.get('params'), stage, lock=lock)
    ok, jpg = cv2.imencode('.jpg', view, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        return _error('Could not encode the image', 500)
    return Response(jpg.tobytes(), mimetype='image/jpeg')


@app.route('/api/align/start', methods=['POST'])
def api_align_start():
    global _job
    err = _vision_required()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    with _job_lock:
        if _job is not None and _job.running:
            return _error('An alignment is already running.', 409)
        try:
            camera_url = body.get('camera_url')
            job = AutoAligner(
                MoonrakerPrinter(body.get('printer')),
                SnapshotCamera(camera_url),
                detect_params=body.get('params'),
                settings=body.get('settings'),
                target=body.get('target'),
                camera_key=camera_url,
                tool=body.get('tool'),
                mode=body.get('mode', 'align'),
                lock=body.get('lock'),
                store=MAPPINGS,
            )
        except HardwareError as e:
            return _error(str(e))
        _job = job
        job.start()
    return jsonify(job.snapshot())


def _mapping_key():
    # Same key the aligner uses: the snapshot URL the UI sends as camera_url.
    return request.args.get('camera') or (request.get_json(silent=True) or {}).get('camera')


@app.route('/api/mapping', methods=['GET', 'DELETE'])
def api_mapping():
    """The saved camera mapping for ?camera=<snapshot url> (GET), or forget it (DELETE)."""
    err = _vision_required()
    if err:
        return err
    key = _mapping_key()
    if not key:
        return _error('camera is required')
    if request.method == 'DELETE':
        return jsonify({'deleted': MAPPINGS.delete(key)})
    entry = MAPPINGS.get(key)
    if not entry:
        return jsonify({'mapping': None})
    import numpy as np
    info = describe_mapping(np.array(entry['matrix']))
    info.update(frame=entry['frame'], saved_at=entry['saved_at'])
    return jsonify({'mapping': info})


@app.route('/api/align/status')
def api_align_status():
    with _job_lock:
        if _job is None:
            return jsonify({'state': 'idle'})
        return jsonify(_job.snapshot())


@app.route('/api/align/cancel', methods=['POST'])
def api_align_cancel():
    with _job_lock:
        if _job is not None:
            _job.cancel()
            return jsonify(_job.snapshot())
    return jsonify({'state': 'idle'})


@app.route('/api/align/revert', methods=['POST'])
def api_align_revert():
    with _job_lock:
        job = _job
    if job is None or job.running:
        return _error('No finished alignment to revert.', 409)
    try:
        return jsonify({'position': job.revert()})
    except (AlignError, HardwareError) as e:
        return _error(str(e), 502)


if __name__ == '__main__':
    try:
        from waitress import serve
        print("Starting AxisScope server on port 3000...")
        serve(app, host='0.0.0.0', port=3000)
    except Exception as e:
        print(f"Error starting server: {e}")
        exit(1)
