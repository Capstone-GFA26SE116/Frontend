import json, io

with io.open("swagger-tmp.json", encoding="utf-8-sig") as f:
    spec = json.load(f)

paths = spec.get("paths", {})
schemas = spec.get("components", {}).get("schemas", {})

want_paths = [
    "/api/subscription-plans",
    "/api/payments/checkout",
    "/api/payments/{paymentId}/sync",
    "/api/payments/{paymentId}/cancel",
    "/api/payment-transactions",
    "/api/invoices",
    "/api/user-subscriptions",
]

for p in want_paths:
    if p not in paths:
        print("MISSING PATH:", p)
        continue
    for method, op in paths[p].items():
        print("=" * 70)
        print(method.upper(), p)
        if isinstance(op, dict):
            print("  summary:", op.get("summary"))
            for prm in op.get("parameters", []) or []:
                if isinstance(prm, dict):
                    print("   param:", prm.get("name"), prm.get("in"), prm.get("required"), json.dumps(prm.get("schema"), ensure_ascii=False))
            rb = op.get("requestBody")
            if rb:
                for ct, media in (rb.get("content") or {}).items():
                    print("   bodyCT:", ct, json.dumps(media.get("schema"), ensure_ascii=False))
            for code, resp in (op.get("responses") or {}).items():
                if not isinstance(resp, dict):
                    continue
                ct = resp.get("content") or {}
                for c, media in ct.items():
                    sch = media.get("schema")
                    print("   resp", code, c, json.dumps(sch, ensure_ascii=False))
                    if sch and "$ref" in sch:
                        ref = sch["$ref"].split("/")[-1]
                        print("      -> schema:", ref, json.dumps(schemas.get(ref), ensure_ascii=False)[:1400])
                    if sch and sch.get("items") and "$ref" in sch["items"]:
                        ref = sch["items"]["$ref"].split("/")[-1]
                        print("      -> item schema:", ref, json.dumps(schemas.get(ref), ensure_ascii=False)[:1400])
