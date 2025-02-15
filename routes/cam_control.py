from axiscope import app
from flask import render_template

@app.route("/xhr/test")
def test():
    print("TESTIES")
    return render_template("index.jinja")
