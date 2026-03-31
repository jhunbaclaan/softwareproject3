import urllib.request
import json
import requests

url = "http://127.0.0.1:8000/agent/run"
data = {
    "prompt": "Call the add-entity tool to add a mixerMaster device. Then call inspect-entity on it to list its fields exactly.",
    "projectUrl": "https://beta.audiotool.com/studio?project=951e0d18-402a-45b4-90ad-f1baa18c11bc",
    "messages": []
}

try:
    with requests.post(url, json=data, stream=True) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if line:
                print(line.decode('utf-8'))
except Exception as e:
    print(f"Error: {e}")
