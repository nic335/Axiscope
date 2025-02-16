from threading import Lock

INIT_LOCK = Lock()

app             = None
settings        = None
__INITIALIZED__ = False
PRINTER_CONFIG  = None
TOOLS           = None
CURRENT_TOOL    = -1




# FULL_PATH       = None
# RUN_DIR         = None
# ARGS            = None


def initialize():
    """Init function for this module"""
    with INIT_LOCK:

        global __INITIALIZED__, app, settings, PRINTER_CONFIG, TOOLS, CURRENT_TOOL #, FULL_PATH, RUN_DIR, ARGS

        if __INITIALIZED__:
            return False

        app.jinja_env.globals.update(printer_url=printer_url)

        # serve(app, host='0.0.0.0', port=8080)
        app.run(host="0.0.0.0", port=settings['port'], debug=True)


        __INITIALIZED__ = True
        return True


def printer_url(path=""):
    return f"http://{settings['printer_url']}{path}"
