"""通用形状提取器原型：不认平台、不写死字段名，递归找数值叶子并按特异性打分。"""
import json, io, re, os

D = os.path.dirname(os.path.abspath(__file__))

CTX_PAT = re.compile(r"context|ctx|window", re.I)
OUT_PAT = re.compile(r"output|completion|max_tokens|max_length", re.I)
RATE_PAT = re.compile(r"price|cost|per_|_per|capacity|rate|limit_|tpm|rpm|request", re.I)


def unwrap(v):
    """{value: N, unit: 'token'} -> (N, 'token')；标量原样返回。"""
    if isinstance(v, dict):
        inner = v.get("value", v.get("max"))
        if isinstance(inner, (int, float)) and not isinstance(inner, bool):
            return inner, v.get("unit")
        return None, None
    if isinstance(v, bool):
        return None, None
    if isinstance(v, (int, float)):
        return v, None
    return None, None


def leaves(node, chain):
    out = []
    if isinstance(node, dict):
        for k, v in node.items():
            out += leaves(v, chain + [(str(k), node)])
    elif isinstance(node, list):
        for it in node:
            out += leaves(it, chain)
    else:
        out.append((chain, node))
    return out


def extract(item):
    ctx_best = out_best = None
    for chain, raw in leaves(item, []):
        if not chain:
            continue
        key, parent = chain[-1]
        val, unit = unwrap(raw)
        if val is None:
            continue
        # {value: N, unit: 'token'} 这种包装：真正的名字是持有它的那一层键
        if key in ("value", "max") and len(chain) >= 2:
            key = chain[-2][0]
        val = int(val)
        if val <= 64 or val > 200000000:
            continue
        # 速率限制一律排除：兄弟键带 per / unit 是 request
        if isinstance(parent, dict) and ("per" in parent or unit == "request"):
            continue
        path_keys = " ".join(k for k, _ in chain)
        if RATE_PAT.search(path_keys):
            continue
        if unit not in (None, "token"):
            continue
        pkey = chain[-2][0] if len(chain) >= 2 else ""
        if CTX_PAT.search(key):
            sc = 100 if "context" in key.lower() else 70
            ctx_best = pick(ctx_best, val, sc)
        elif OUT_PAT.search(key):
            sc = 100
            if "output" not in key.lower() and "output" in str(pkey).lower():
                sc = 95
            if key.lower() in ("max", "max_tokens"):
                sc = 60
            out_best = pick(out_best, val, sc)
    return (ctx_best[1] if ctx_best else None), (out_best[1] if out_best else None)


def pick(cur, val, sc):
    if cur is None or sc > cur[0]:
        return (sc, val)
    return cur


CASES = [
    ("unisound", os.path.join(D, "unisound-models.json"), ["glm-5.3", "kimi-k2.6", "minimax-m3", "u2-med"]),
    ("intern-ai", os.path.join(D, "intern-models.json"), ["glm-5.3", "kimi-k2.6", "minimax-m3", "Agents-A1"]),
    ("agnes", os.path.join(D, "agnes-models.json"), ["agnes-2.5-pro", "agnes-video-2.5"]),
]

# SenseNova 形状按官方文档样例构造（文档里那条完整响应）
SENSE = {"id": "sensenova-6.8-flash-lite", "context_length": 262144, "max_output_length": 65536,
         "pricing": {"prompt": "0", "completion": "0"}, "created": 1777392000}

for name, path, want in CASES:
    d = json.load(io.open(path, encoding="utf-8"))["data"]
    idx = {str(x.get("id")).lower(): x for x in d}
    print("=== %s（%d 条）===" % (name, len(d)))
    for wid in want:
        x = idx.get(wid.lower())
        if x is None:
            print("   %-22s 该响应里没有" % wid)
            continue
        c, o = extract(x)
        print("   %-22s 自动提取 ctx=%-10s out=%-10s   原始 ctx=%-10s out=%s" % (
            wid, c, o,
            x.get("context_window") or x.get("context_length") or (
                (x.get("input_modalities") or [{}])[0].get("supported_inputs", {})
                .get("max_context_length", {}).get("value")),
            x.get("max_output") or x.get("max_output_length") or (
                (x.get("output_modalities") or [{}])[0].get("max_length", {}).get("value"))))
    # 全量覆盖率
    ok = sum(1 for x in d if extract(x)[0] is not None)
    print("   ctx 提取成功率 = %d/%d" % (ok, len(d)))

c, o = extract(SENSE)
print("=== sensenova（文档样例）===\n   ctx=%s out=%s（期望 262144 / 65536）" % (c, o))
