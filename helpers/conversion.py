

def convert_str(value):
    try:
        value = float(value)

        if value == int(value):
            return int(value)

        else:
            return value

    except:
        return value


