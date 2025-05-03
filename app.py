import os
from flask.app import Flask
from flask.helpers import send_from_directory

app = Flask(__name__)

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

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
