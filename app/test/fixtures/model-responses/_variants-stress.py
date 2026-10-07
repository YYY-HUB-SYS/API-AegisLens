"""用合成变体压提取器：这些是真实世界里存在的 schema 家族，不需要新 key 就能构造。"""
import io, os

HERE = os.path.dirname(os.path.abspath(__file__))

# 只取 extract()，不跑它的自测 main
src = io.open(os.path.join(HERE, "_extractor-proto.py"), encoding="utf-8").read()
head = src.split("CASES = [")[0]
ns = {"__file__": os.path.join(HERE, "_extractor-proto.py")}
exec(compile(head, "ax", "exec"), ns)
extract = ns["extract"]

CASES = [
    ("1 扁平 snake（SenseNova）", {"id": "a", "context_length": 262144, "max_output_length": 65536}, 262144, 65536),
    ("2 扁平 window（云知声）", {"id": "a", "context_window": 1048576, "max_output": 131072}, 1048576, 131072),
    ("3 嵌套 {value,unit}（intern）", {"id": "a", "input_modalities": [{"supported_inputs": {"max_context_length": {"value": 262144, "unit": "token"}}}], "output_modalities": [{"max_length": {"value": 262144, "unit": "token"}}]}, 262144, 262144),
    ("4 无数值字段（agnes）", {"id": "a", "owned_by": "custom", "supported_endpoint_types": ["openai"]}, None, None),
    ("5 model_limits 子对象（Together 派）", {"id": "a", "model_limits": {"max_context_window_tokens": 131072, "max_tokens": 8192, "supported": True}}, 131072, 8192),
    ("6 字符串数字", {"id": "a", "context_length": "262144", "max_output_length": "65536"}, 262144, 65536),
    ("7 单位是 K（值需换算）", {"id": "a", "context": {"value": 262, "unit": "K"}}, 262000, None),
    ("8 只有 max_input_tokens", {"id": "a", "max_input_tokens": 991000}, None, None),
    ("9 capabilities 子对象", {"id": "a", "capabilities": {"context": 200000, "tools": True}}, 200000, None),
    ("10 速率与上下文并存（陷阱）", {"id": "a", "context_length": 8192, "rate_limits": {"tokens": {"per_minute": 500000}}}, 8192, None),
    ("11 价格里有大数（陷阱）", {"id": "a", "context_length": 32768, "pricing": {"input": 0.8, "output": 2.4}}, 32768, None),
    ("12 没有 id 只有 name", {"name": "solo-7b", "context_length": 32768}, 32768, None),
    ("13 camelCase", {"id": "a", "contextLength": 65536, "maxOutputTokens": 4096}, 65536, 4096),
    ("14 全 0 / 负数", {"id": "a", "context_length": 0, "max_output_length": -1}, None, None),
    ("15 超大值（哨兵）", {"id": "a", "context_length": 999999999999}, None, None),
]

ok = bad = 0
for label, item, wctx, wout in CASES:
    c, o = extract(item)
    good = (c == wctx and o == wout)
    ok += good
    bad += (not good)
    print("%-4s %-34s 提取得 ctx=%-10s out=%-9s | 期望 ctx=%-10s out=%s" %
          ("PASS" if good else "FAIL", label, c, o, wctx, wout))

print("\n%d/%d 通过，%d 个变体不符" % (ok, len(CASES), bad))
