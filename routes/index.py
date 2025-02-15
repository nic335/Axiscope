from axiscope import app, settings
from flask import render_template


@app.route("/")
def index():
    return render_template(
        "index.jinja",
        title="AxiScope",
        settings=settings
    )
