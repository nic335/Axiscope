from flask import Flask, render_template
from helpers.file import read_json_file
import os

import axiscope

axiscope.app      = Flask(__name__)
axiscope.settings = read_json_file(os.path.join(os.getcwd(), "settings.json"))

@axiscope.app.route("/")
def index():
    return render_template(
        "index.jinja",
        title="AxiScope",
        settings=axiscope.settings
    )

if __name__ == "__main__":
    axiscope.initialize()
