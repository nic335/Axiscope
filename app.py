import os
from flask.app import Flask
from flask.helpers import send_from_directory
from flask import jsonify, request

import v4l2_control

app = Flask(__name__)

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/api/v4l2/devices')
def api_v4l2_devices():
    devices = v4l2_control.list_devices()
    return jsonify({'devices': [d.to_dict() for d in devices]})

@app.route('/api/v4l2/controls')
def api_v4l2_controls():
    device = request.args.get('device')
    if not device:
        return jsonify({'error': 'device is required'}), 400
    controls, grouped = v4l2_control.list_controls(device)
    return jsonify({
        'groups': {
            category: [c.to_dict() for c in ctrls]
            for category, ctrls in grouped.items()
        }
    })

@app.route('/api/v4l2/set_control', methods=['POST'])
def api_v4l2_set_control():
    data = request.get_json(silent=True) or {}
    device = data.get('device')
    control = data.get('control')
    value = data.get('value')
    if not device or not control or value is None:
        return jsonify({'error': 'device, control, and value are required'}), 400
    success = v4l2_control.set_control(device, control, value)
    return jsonify({'success': success})

@app.route('/<path:path>')
def serve_files(path):
    return send_from_directory('.', path)

if __name__ == '__main__':
    try:
        from waitress import serve
        print("Starting AxisScope server on port 3000...")
        serve(app, host='0.0.0.0', port=3000)
    except Exception as e:
        print(f"Error starting server: {e}")
        exit(1)
