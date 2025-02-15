
from flask import json
import os

def export_to_file(file_path, data):
    with open(file_path+'.tmp', 'w+', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

    try:
        os.replace(os.path.abspath(file_path+'.tmp'), os.path.abspath(file_path))
    except Exception as e:
        print(e)

def read_json_file(file_path):
    with open(file_path) as f: 
        return json.load(f)