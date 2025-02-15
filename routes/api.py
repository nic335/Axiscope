import axiscope
from axiscope import app, printer_url
from helpers.conversion import convert_str
from flask import json, jsonify, render_template
from urllib.request import urlopen

@app.route("/xhr/get_printer_config")
def get_printer_config():
    tools = {}
    url   = printer_url("/printer/objects/query?configfile&toolchanger")

    try:
        with urlopen(url) as response:
            data       = json.loads(response.read().decode())
            ready      = data['result']['status']['toolchanger']['status'] == "ready"
            tool_names = data['result']['status']['toolchanger']['tool_names']

            for tool_name in tool_names:
                tool_data              = {k:convert_str(v) for k, v in data['result']['status']['configfile']['config'][tool_name].items()}
                tool_data['tool_name'] = tool_name
                number                 = tool_data['tool_number']
                tools[number]          = tool_data

            
        axiscope.PRINTER_CONFIG = data['result']['status']['configfile']['config']
        axiscope.CURRENT_TOOL   = convert_str(data['result']['status']['toolchanger']['tool_number']) if ready else -1
        axiscope.TOOLS          = tools
        
    except:
        return jsonify({"success": False})

    return jsonify({"success": True})