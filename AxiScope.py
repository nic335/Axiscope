from flask import Flask
from helpers.file import read_json_file
import os
# from waitress import serve

import axiscope

axiscope.app           = Flask(__name__)
axiscope.settings      = read_json_file(os.path.join(os.getcwd(), "settings.json"))


import routes.index
import routes.api
import routes.tools


if __name__ == "__main__":
    axiscope.initialize()

    
    # serve(app, host='0.0.0.0', port=8080)
    # app.run(host="0.0.0.0", port=5000, debug=True)