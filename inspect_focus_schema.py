import json

d = json.load(open("swagger-live.json"))
for p in sorted(d["paths"]):
    if "auth" in p.lower() or "login" in p.lower() or "register" in p.lower():
        print(p, list(d["paths"][p].keys()))
