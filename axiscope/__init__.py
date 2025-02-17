from threading import Lock

INIT_LOCK = Lock()

app             = None
settings        = None
__INITIALIZED__ = False


def initialize():
    """Init function for this module"""
    with INIT_LOCK:

        global __INITIALIZED__, app, settings

        if __INITIALIZED__:
            return False

        app.jinja_env.globals.update(printer_url=printer_url)
        app.jinja_env.globals.update(bounce_move_url=bounce_move_url)
        app.jinja_env.globals.update(course_move_url=course_move_url)

        # serve(app, host='0.0.0.0', port=8080)
        app.run(host=settings['host'], port=settings['port'], debug=True)


        __INITIALIZED__ = True
        return True


def printer_url(path=""):
    return f"http://{settings['printer_url']}{path}"


def bounce_move_url(axis, move, bounce_length=1, speed=500):
    url = printer_url("/printer/gcode/script?script=")
    url += "SAVE_GCODE_STATE NAME=bounce_move%0A"
    url += "G91%0A"

    if move < 0:
        url += f"G0 {axis}-{(bounce_length+abs(move))} F{speed}%0A"
        url += f"G0 {axis}{bounce_length} F{speed}%0A"
    else:
        url += f"G0 {axis}{bounce_length+move} F{speed}%0A"
        url += f"G0 {axis}-{bounce_length} F{speed}%0A"

    url += "RESTORE_GCODE_STATE NAME=bounce_move"

    return url


def course_move_url(axis, move):
    url = printer_url("/printer/gcode/script?script=")
    url += "SAVE_GCODE_STATE NAME=course_move%0A"
    url += "G91%0A"
    url += f"G0 {axis.upper()}{move} F{6000 if axis.upper() in ['X', 'Y'] else 1500}%0A"
    url += "RESTORE_GCODE_STATE NAME=course_move"

    return url


