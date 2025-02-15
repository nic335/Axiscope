import axiscope
from axiscope import app
from flask import render_template

@app.route("/xhr/all_tools")
def xhr_all_tools():

    return render_template(
        "tools.jinja",
        tools       =axiscope.TOOLS,
        current_tool=axiscope.CURRENT_TOOL,
        initialized = axiscope.CURRENT_TOOL > -1
    )


# @app.route("/xhr/tool/<int:tool_no>")
# def xhr_tool():
#     # TODO
#     return render_template(
#         "tools.jinja",
#         tools       =axiscope.TOOLS,
#         current_tool=axiscope.CURRENT_TOOL,
#         initialized = axiscope.CURRENT_TOOL > -1
#     )