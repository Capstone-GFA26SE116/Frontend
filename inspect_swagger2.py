import json, io

with io.open("swagger-tmp.json", encoding="utf-8-sig") as f:
    spec = json.load(f)

schemas = spec.get("components", {}).get("schemas", {})

for name in ["CheckoutRequestDto", "MeResponse", "MeDto", "CurrentSubscriptionDto", "SubscriptionStatus", "PaymentStatus"]:
    if name in schemas:
        print("=" * 70)
        print(name, json.dumps(schemas[name], ensure_ascii=False, indent=1))
    else:
        print("NOT FOUND:", name)

print("\n=== ALL schema names containing Sub/Plan/Pay/Invo ===")
for k in sorted(schemas):
    if any(s.lower() in k.lower() for s in ["sub", "plan", "pay", "invo", "me", "status"]):
        print(" -", k)
