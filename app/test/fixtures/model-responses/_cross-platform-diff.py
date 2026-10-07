import json, io, os

D = os.path.dirname(os.path.abspath(__file__))
uni = json.load(io.open(os.path.join(D, "unisound-models.json"), encoding="utf-8"))["data"]
itn = json.load(io.open(os.path.join(D, "intern-models.json"), encoding="utf-8"))["data"]

def cx(x):
    for m in x.get("input_modalities") or []:
        v = ((m.get("supported_inputs") or {}).get("max_context_length") or {}).get("value")
        if v is not None:
            return v
    return None

def ou(x):
    for m in x.get("output_modalities") or []:
        v = (m.get("max_length") or {}).get("value")
        if v is not None:
            return v
    return None

def sp(x):
    om = (x.get("output_modalities") or [{}])[0]
    return set((om.get("supported_parameters") or {}).keys())

def mods(x):
    return ",".join(sorted({m.get("type") for m in (x.get("input_modalities") or [])}))

def rpm(x):
    for c in x.get("capacity") or []:
        if c.get("type") == "request":
            return c.get("value")
    return None

U = {str(x.get("id")).lower(): x for x in uni}
I = {}
for x in itn:
    I[str(x.get("id")).lower()] = x

shared = sorted(set(U) & set(I))
print("两家 id 完全同名重叠 = %d 条：%s\n" % (len(shared), ", ".join(shared)))
print("%-26s %-22s %-22s %s" % ("模型 id", "云知声 ctx/out", "intern ctx/out", "差异"))
for k in shared:
    a, b = U[k], I[k]
    ac, ao, bc, bo = a.get("context_window"), a.get("max_output"), cx(b), ou(b)
    tags = []
    if ac != bc: tags.append("ctx %s→%s" % (ac, bc))
    if ao != bo: tags.append("out %s→%s (%.1fx)" % (ao, bo, (bo / ao) if ao and bo else 0))
    tags.append("intern 独有: reasoning=%s rpm=%s in=%s" % ("reasoning" in sp(b), rpm(b), mods(b)))
    print("  %-24s %-22s %-22s %s" % (k, "%s/%s" % (ac, ao), "%s/%s" % (bc, bo), "  ".join(tags)))
