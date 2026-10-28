import json, io

with io.open("swagger-tmp.json", encoding="utf-8-sig") as f:
    spec = json.load(f)

schemas = spec.get("components", {}).get("schemas", {})

print(json.dumps(schemas.get("MeSubscriptionDto"), ensure_ascii=False, indent=1))

paths = spec.get("paths", {})
print("\n=== /api/me ===")
for method, op in (paths.get("/api/me") or {}).items():
    print(method, json.dumps(op.get("responses"), ensure_ascii=False)[:900])

print("\n=== payment-related paths ===")
for p in sorted(paths):
    if "payment" in p or "invoice" in p or "subscription" in p:
        print(p, list(paths[p].keys()))
