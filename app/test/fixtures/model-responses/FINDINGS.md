# `/v1/models` 实测档案：十一家平台 · 十一种 schema

## 采集时间与效力声明

**数据采集时间：2026-10-07 18:1x–18:5x（UTC+8），本机直连、未走代理。**

本档案记录的是**那一刻**各家 `/v1/models` 的实际返回值，**仅供参考，不是长期事实**：

- 各家随时可以改字段名、改数值、改 schema，也可能改 `User-Agent` 嗅探策略（§5b 那条尤其脆弱）。
- 模型清单本身在变：带日期的别名（`-0731` / `-0813` / `-2412` / `-2504`）会随版本轮换消失。
- 配额类数值（§4b 的 RPM/TPM）绑定当时那个测试账号的套餐档位，换账号即不同。
- 因此本目录的价值在于**「同一件事有十种互不兼容的写法」这个结构性事实**，
  以及由它推出的解析与信任规则；具体数字只作为该时点的样本。
- 复现请按下文 §10 重跑，不要引用本文件的数字作为当前值。

采集方式：`GET <base>/models` + `Authorization: Bearer <一次性测试密钥>`。
**密钥已全部作废，本目录不含任何凭据**（已按 11 把 key 前缀、UUID 形态、通用长串三种方式
在工作副本与 git blob 两侧复扫）；下表与 §10 中的 `<REDACTED-KEY>` 均为占位符。
商汤官方接口文档正文属第三方版权内容，**不随本档案入库**，字段说明见 §1 表格。

原始响应体逐字节留存于本目录，未做任何清洗：

| 文件 | 平台 | Base URL（复现用） | HTTP | 字节 | 耗时 | 模型条数 |
|---|---|---|---|---|---|---|
| `sensenova-models.json` | 商汤 SenseNova | `https://token.sensenova.cn/v1` | 200 | 6691 | 0.21s | 9 |
| `unisound-models.json` | 云知声 MaaS | `https://maas-api.unisound.com/v1` | 200 | 3171 | 1.92s | 22 |
| `agnes-models.json` | agnes-ai | `https://api.agnes-ai.cn/v1` | 200 | 1396 | 0.30s | 11 |
| `intern-models.json` | 上海AI实验室 TokenPlan | `https://discovery-api.intern-ai.org.cn/v1` | 200 | 10570 | 2.25s | 10 |
| `longcat-models.json` | 美团 LongCat | `https://api.longcat.chat/openai/v1` | 200 | 322 | 0.36s | 2 |
| `amd-radeon-models.json` | AMD Radeon AI PRO | `https://developer.amd.com.cn/radeon/api/v1` | 200 | 8737 | 1.26s | 9 |
| `antling-models.json` | 蚂蚁 AntLing | `https://api.ant-ling.com/v1` | 200 | 929 | 1.67s | 11 |
| `openrouter-defaultua-sample.json` | OpenRouter（默认 UA） | `https://openrouter.ai/api/v1` | 200 | 774407 | 3.49s | 465（**仅存前 3 条样本 + 计数**） |
| `openrouter-toolua-stub.json` | OpenRouter（工具 UA） | 同上，**同一把 key、同一 URL** | 200 | 2190 | 0.82s | 10（全量存档） |
| `modelscope-models.json` | ModelScope 推理 | `https://api-inference.modelscope.cn/v1` | 200 | 3200 | 0.30s | 35 |
| `atria-models.json` | Atria（源头厂商） | `https://api.atria-asi.ai/v1` | 200 | 102 | 1.52s | 1 |
| `diandian-dots-models.json` | 小红书 Dots（note3-prev） | `https://note3-prev-api.askdiandian.com/v1` | 200 | **56** | 1.00s | 1 |

合计 **111 条模型**（不含 OpenRouter 的 465 条：那份只存了 3 条样本，未计入命中率统计）。
十一家全部直连可达、无需代理。四条最严重的发现：OpenRouter **§5b**（UA 分叉）、
Dots **§5c**（仓库内两张内置表互不自洽）、Atria **§5d**（源头给得比转售方少）、
ModelScope **§5e**（hub 型平台联网覆盖率仅 ~55%）。

---

## 1. 五种互不兼容的 schema

| # | 平台 | 上下文字段路径 | 最大输出字段路径 | 其他字段 |
|---|---|---|---|---|
| 1 | SenseNova | `context_length` | `max_output_length` | `pricing{5}` `input/output_modalities[]` `supported_features[]` `supported_sampling_parameters[]` `quantization` `created` `description` `hugging_face_id` `openrouter.slug` `datacenters[]` |
| 2 | 云知声 | `context_window` | `max_output` | `max_input` `owned_by` `created` |
| 3 | agnes-ai | **不提供** | **不提供** | `owned_by:"custom"` `supported_endpoint_types[]` `created`(全为占位值 1626777600) |
| 4 | intern-ai | `input_modalities[].supported_inputs.max_context_length.value` | `output_modalities[].max_length.value` | `schema_version:"2.4"` `total_count` `is_ready` `capacity[]`(RPM/TPM) `supported_parameters{max_tokens,temperature,top_p,tools,stop,structured_outputs,reasoning}` `streaming` `owned_by` `openrouter.slug` |
| 5 | LongCat | `context_window` | **`max_output_tokens`** | `display_name` `owned_by` |
| 6 | AMD Radeon | `context_length` | **不提供**（`top_provider` 里也没有 `max_completion_tokens`） | `providers[].{vision,tools,reasoning,parallelToolCalls,streaming,cancellation,ocr,stability,pricing}` `architecture.{input_modalities,output_modalities,tokenizer}` `supported_parameters[]`(名字数组) `aliases[]` `family` `free` `json_output` `structured_outputs` `name` `description` |
| 7 | AntLing | **不提供** | **不提供** | `owned_by` `created`（除 `id/object` 外仅这两个字段，最简的一家） |
| 8a | OpenRouter（默认 UA） | `context_length` | `top_provider.max_completion_tokens` | `architecture` `canonical_slug` `default_parameters` `description` `expiration_date` `hugging_face_id` `knowledge_cutoff` `name` `per_request_limits` `pricing` `reasoning` `supported_parameters` `supported_voices` |
| 8b | OpenRouter（工具 UA · 同一 key 同一 URL） | **不提供** | **不提供**（只有 `max_input_tokens` / `max_tokens`） | `capabilities` `created_at` `display_name` `type` —— schema 与 8a **完全不同**，见 §5b |
| 9 | 小红书 Dots | **不提供** | **不提供** | 仅 `owned_by:"system"`；**连 `object` 都没有**，全响应 56 字节，最简的一家。且 `/models` **不校验密钥**（无 key / 错 key 均返回同一份），见 §5c |
| 10 | Atria | **不提供** | **不提供** | `owned_by:"atria"` `created: 0`（第三种空值编码），见 §5d |
| 11 | ModelScope | **不提供** | **不提供** | 35 条全为 `org/Name` 命名空间（16 个 org）；`object` 是**空字符串 `""`**（第四种空值编码），见 §5e |

顶层键十一家都是 `data`（intern 另有 `total_count`，agnes 另有 `success`，多数另有 `object`）。

AMD 是**能力位最富**的一家，但 `context_length: 0` 表示"未设"（`MinerU2.5-Pro`），且 `pricing.prompt` 是**科学计数法字符串** `"1.4e-7"` —— 见 §6 变体①。

## 2. 现状代码的命中率：ctx 17/111、out 9/111

`app/src/adapters.js` 的 `fetchModels` 只读 `item.context_length` 与 `item.max_output_length`（见 359–360 行附近）：

```
平台              条数   ctx 现状    out 现状
sensenova           9     9/9        9/9      ← 唯一两边都命中的一家
unisound           22     0/22       0/22
agnes              11     0/11       0/11     ← 本就不提供，属正常
intern             10     0/10       0/10
longcat             2     0/2        0/2
amd-radeon          9     8/9        0/9      ← ctx 命中但 out 平台确实没给
antling            11     0/11       0/11     ← 本就不提供
dots               1      0/1        0/1      ← 本就不提供（56 字节，见 §5c）
atria              1      0/1        0/1      ← 本就不提供（见 §5d）
modelscope        35      0/35       0/35     ← 本就不提供（hub 型，见 §5e）
合计              111    17/51      9/42      ← 分母=平台真实提供了该字段的条数
```

**平台明确报了数值、而我们没接住的：ctx 丢 34 条（云知声 22 + intern 10 + LongCat 2），out 丢 33 条（云知声 21 + intern 10 + LongCat 2）。**

## 3. 通用形状提取器的命中率：ctx 51/51、out 42/42

`_extractor-proto.py`（不认平台、不写字段名表；递归找数值叶子 + 特异性打分）对同一批真实数据：

```
平台              ctx 提取    out 提取      说明
sensenova         9/9        9/9
unisound         22/22       21/22         ← u2-med 的 max_output 真是 null，正确留空
agnes             0/0        0/0           ← 无该字段，正确为空、未瞎编
intern           10/10       10/10         ← 两层嵌套 {value,unit}
longcat           2/2        2/2           ← max_output_tokens 全新命名
amd-radeon        8/8        0/0           ← context_length:0 那条正确判为"未设"
antling           0/0        0/0
dots              0/0        0/0
atria             0/0        0/0
modelscope        0/0        0/0        ← 35 条全为 org/Name，无字段可取
合计             51/51       42/42         ← 对平台真实提供的字段，零漏取、零误报
```

四条护栏：
1. 兄弟键含 `per` 或 `unit=="request"` → 判为速率限制，丢弃（否则 intern 的 `capacity.value = 5005000000` 会被当成 50 亿上下文）
2. `64 < v <= 200000000` 量级窗口（挡掉 `temperature.max=2`、`stop.max_items=4`）
3. 键名特异性：含 `context` > 只含 `window`；`max_length` 挂在 `output_modalities` 下 > `supported_parameters.max_tokens.max`
4. 单位非 token → 拒绝

**LongCat 这一家直接否掉了"手写别名表"方案**：它的输出字段叫 `max_output_tokens`，不在我曾提议的 `max_output_length | max_output | max_completion_tokens` 三个别名里，别名表会漏。

## 4. 跨平台同名模型的限制值互相冲突

云知声与 intern-ai 有 4 条 id **完全同名**：

| 模型 id | 云知声 ctx/out | intern ctx/out | 差异 |
|---|---|---|---|
| `deepseek-v4-flash-0731` | 1048576 / 393216 | 1048576 / 1048576 | out 2.7× |
| `glm-5.3` | 1048576 / 131072 | 1048576 / 1048576 | out **8.0×** |
| `kimi-k2.6` | 262144 / **16000** | 262144 / 262144 | out **16.4×** |
| `minimax-m3` | **524288** / 1048576 | 1048576 / 1048576 | ctx 2× |

**结论：模型能力/限制是 `(平台端点, 模型)` 的二元事实，不是模型的全局属性。** 任何"按模型 id 全局查表"的来源（联网目录、内置元表）定义上只能给猜测。

存储层已天然是这个粒度：`storage.js` 的 `replaceModels(keyId, models)` 把模型挂在每条密钥文档上，加字段不需要新表。

## 4b. 能力位实测矩阵（回答"模型能力能不能体现出来"）

**能，而且七家给的维度互不相同、且逐条变化**（不是套壳常量）。最富的是 AMD：

| 模型 | ctx | vision | tools | parallel | reasoning | streaming | pricing.prompt |
|---|---|---|---|---|---|---|---|
| `DeepSeek-V4.1-Flash` | 1048576 | ✓ | ✓ | ✗ | ✓ | ✓ | `"1.4e-7"` |
| `DeepSeek-V4-Flash` | 1048576 | ✗ | ✓ | ✗ | ✓ | ✓ | `"1.4e-7"` |
| `DeepSeek-V4-Flash-Vision-E` | 1048576 | ✓ | ✓ | ✗ | ✓ | ✓ | `"1.4e-7"` |
| `GLM-5.3-Flash` | 262144 | ✗ | ✓ | ✗ | ✓ | ✓ | `"1.5e-7"` |
| `MiMo-V2.6-Flash` | 1048576 | ✓ | ✓ | ✗ | ✓ | ✓ | `"1.4e-7"` |
| `MinerU2.5-Pro` | **0** | ✗ | ✗ | ✗ | ✗ | ✗ | `"0"` |
| `MiniCPM5-2B` | 131072 | ✗ | ✓ | ✗ | ✓ | ✓ | `"1.24e-7"` |
| `Qwen3.8-27B` | 262144 | ✓ | ✓ | ✗ | ✓ | ✓ | `"5e-7"` |
| `Qwen3.8-Flash-Next` | 262144 | ✓ | ✓ | ✗ | ✓ | ✓ | `"1.5e-7"` |

`vision` 5真4假、`context_length: 0` 表示未设、价格是**科学计数法字符串**。
另有 `supported_parameters: ["temperature","max_tokens","top_p","stream","response_format","tools","tool_choice"]`（名字数组，与 intern 的参数字典形态不同）、`architecture.input_modalities`、`free`、`json_output`、`ocr`、`cancellation`、`stability:"experimental"`。

七家能力位覆盖度：

| 能力维度 | 给该维度的平台 | 形态 |
|---|---|---|
| 是否推理/思考 | AMD `providers[].reasoning`、intern `supported_parameters.reasoning`、SenseNova `supported_features[]` | bool / 键存在性 / 枚举成员，**三种形态** |
| 输入模态 | AMD `architecture.input_modalities`、intern `input_modalities[].type`、SenseNova `input_modalities[]` | 对象内数组 / 对象数组 / 字符串数组，**三种形态** |
| 速率限制 | intern `capacity[]`（RPM/TPM，逐条不同：2640/3000/2000/2100/2200/4000/30000） | **只有这一家有** |
| 定价 | SenseNova `pricing{5}`、AMD `providers[].pricing` + `pricing` | 字符串数 / 科学计数法字符串 |
| 工具调用 | AMD `providers[].tools`、intern `supported_parameters.tools`、SenseNova `supported_features` | 同上多形态 |
| 最大输入 | 云知声 `max_input`（与 `context_window` **不等**：qwen3.7-plus 991000 vs 1048576） | 只有这一家有 |

**结论：能力位无法靠一张全局表覆盖，只能按形状发现 + 按 `(密钥, 模型)` 粒度存。** 公开目录（联网那一级）不带 RPM、不带 `vision` 真值、也不认识 `MinerU2.5-Pro` 这种。

## 5. 现状行为会写进库的错值（LongCat 实证，最硬的一条）

LongCat 解析失败 → ctx/out 为空 → `enrichUnknowns`（判据 `m.ctx == null`）触发联网 → 写回：

| 模型 | 平台自报 ctx/out | 联网实际写进库的 |
|---|---|---|
| `LongCat-2.0` | 1048576 / **131072** | **1048756** / **262144** |
| `LongCat-2.5-Preview` | 1048576 / **262144** | **1000000** / **131072** |

两个后果：
- **`out` 在两个模型之间正好调包。** 按库里的 262144 给 `LongCat-2.0` 配 `max_tokens`，该端点实际只收 131072。
- **`1048756` 是上游目录的手误**（真值 `1048576 = 2^20`，5 与 7 敲反）。我们会把一个错别字当事实存进库。

且这三步全程无异常：HTTP 200、`modelsFetched=true`、徽标显示来源「平台接口」。

## 5b. 同一把 key、同一个 URL，**换 User-Agent 就换一份 API**（八家里最严重的一条）

OpenRouter 会嗅探 `User-Agent`。`adapters.js` 的 `authHeaders()` 给**所有**平台调用注入
`TOOL_UA = 'claude-cli/1.0.23 (external, cli)'`（本意是过 Agent Router 那类中转站的客户端指纹检测）。
实测同一 `https://openrouter.ai/api/v1/models` + 同一把 key：

| UA | HTTP | 字节 | 模型条数 | 带 `context_length` | 响应 schema |
|---|---|---|---|---|---|
| 默认（undici） | 200 | 774407 | **465** | **465** | `architecture / canonical_slug / context_length / created / default_parameters / description / expiration_date / hugging_face_id / id / knowledge_cutoff / name / per_request_limits / pricing / reasoning / supported_parameters / supported_voices / top_provider` |
| `claude-cli/1.0.23` | 200 | 2190 | **10** | **0** | `capabilities / created_at / display_name / id / max_input_tokens / max_tokens / type` |

**两份数据完全不一样**，不是"少几条"的关系：stub 的 id 是 `anthropic/openai/gpt-6.1-sol[1m]`、`anthropic/claude-fable-5.1[1m]` 这种 `anthropic/` 前缀挂 `gpt-` 模型的形态，且**一条 `context_length` 都没有**。

真实 `fetchModels` 走应用代码路径实测：**返回 10 条，10/10 ctx=null out=null，全标 `src='api'`** —— 而它本可以拿到 465 条全带上下文的。

两点边界要说清：
- **联网检索那一级不受影响**：`enrich.js` 的 `fetchProvider` 只传 `{signal}` 不带 headers，所以它看到的仍是完整 465 条目录。受影响的只有"把 OpenRouter 当一个平台密钥来用"这条路径。
- **不能直接删 `TOOL_UA`**：它存在的理由（`adapters.js:237-239` 注释）是有的中转站会对 Node 默认 UA 返 `401 unauthorized client detected`。删了那批站会退回不可用。
  可选修法：① 按 host 白名单，已知公开目录域（`openrouter.ai`、models.dev）不发 `TOOL_UA`；② 响应退化时（0 条 / 全无上下文字段）换 UA 重试一次；③ 做成每个密钥可覆写的字段，沿用现成的 `authOverrideOf(url)` 按 URL 覆盖机制。

存档：`openrouter-defaultua-sample.json`（默认 UA，取前 3 条 + 计数摘要；完整 465 条 774407 字节未整份入库）、`openrouter-toolua-stub.json`（工具 UA，10 条全量）。

## 5c. 小红书 Dots：`/models` 不校验密钥，且**撞出我们仓库内两张内置表互不自洽**

响应只有 56 字节、1 条模型，字段仅 `id` + `owned_by:"system"`，连 `object` 都没有：

```json
{"data":[{"id":"dots3-note-prev","owned_by":"system"}]}
```

**四种认证方式返回逐字节相同的 200**：`Authorization: Bearer <key>`、`api-key: <key>`、**完全不带 key**、**故意用错 key**。这个 `/models` 不校验密钥。

> 这一条**现有代码已经处理对了**，不是缺陷：`adapters.js` 的 `AUTH_OVERRIDES` 里有
> `{ re: /(^|\.)askdiandian\.com$/i, header: 'api-key', publicModels: true }`，
> `testKey()` 见 `publicModels` 就改走 `chatAuthFallback()` 做对话接口鉴权探测。
> 我最初怀疑"错 key 也会报可用"，实读代码后确认不成立。

真实 `fetchModels` 走生产路径的结果：`{ id: 'dots3-note-prev', ctx: 524288, out: null, src: 'meta' }`
—— 数值全部来自我们自己的内置表，平台一条没给。

**而内置的两张表对同一个模型给的数互不自洽：**

| 来源 | ctx | out |
|---|---|---|
| `src/meta-models.json:44`（`lookupMeta` 用） | **524288** | `null` |
| `src/cn-models.js:57`（`enrich` 的 modelsdev provider 用） | **131072** | **16384** |

**ctx 差 4 倍，out 一个 null 一个 16384。** 谁对不知道，两处都无来源标注。

今天不出事，是因为 `api.js:266` 的联网触发判据**只看 `ctx`**：`merged.some(mm => mm.ctx == null)`。
这里 ctx 已被 meta 填成 524288 → 判据为假 → 连 `cn-models` 都不查 → **`out` 永久空白，而 16384 那个值就躺在同一个仓库里取不到。**

⚠️ **这是 B 落地的前置陷阱。** 手工串 `lookupOnline` + `applyToModels` 实测：一旦把触发判据放宽成"任一字段为空就补"（B 清单第 1 条必然要动这里），立刻产出这条缝合记录：

```
{ ctx: 524288, out: 16384, src: 'web' }
   ↑ 来自 meta-models   ↑ 来自 cn-models   ↑ 且标签把 meta 来的 ctx 说成 web
```

两个来源本身就互相矛盾，`src` 还是单值（`enrich.js:201` 见任一字段被改就把整条翻成 `'web'`）。
**所以 B 必须先定一条"来源冲突规则"**（同字段多来源不一致时：取谁、标谁、要不要并排显示），
否则"按字段四级兜底"会把仓库里已有的矛盾放大成静默混合记录。这条规则此前不在清单里。

## 5d. Atria：同一个模型，**源头厂商给得比转售方少**

`https://api.atria-asi.ai/v1/models` → 200 / 102 字节 / 1 条：

```json
{"object":"list","data":[{"id":"Atria-Dawn-Preview","object":"model","created":0,"owned_by":"atria"}]}
```

`created: 0` 是**第三种空值编码**（对照：agnes 用占位未来时间戳 `1626777600`，Dots 干脆没有 `created` 字段）。

这个模型 id 在 intern-ai 的清单里出现过，于是凑成三方对照：

| 来源 | 角色 | ctx | out |
|---|---|---|---|
| `api.atria-asi.ai` | **源头厂商**（`owned_by:"atria"`） | 不提供 | 不提供 |
| `discovery-api.intern-ai.org.cn` | 转售方（`owned_by:"tokenplan"`） | 524288 | 524288 |
| 公开目录（models.dev / OpenRouter） | 第三方 | 262144 | 262144 |

**两个含义，都指向 B 的具体规则：**

1. **最权威的通道给的信息最少。** "平台自报值优先"这条原则不因此改变（这里没有可冲突的值），但它证明**按字段兜底那一层不能删** —— 否则 Atria 这类端点的模型参数永远全空。
2. **给第 0b 条"冲突规则"补了一个必须回答的情形**：源头无表态、转售方与公开目录差 2 倍时取谁。
   我的建议：**取转售方自报值**（524288），因为那才是你手上这把 key 实际要打的端点；公开目录只作参考并标注。
   这是 §8 信任序的落地细化，需要他拍一次。

## 5e. ModelScope：hub 型清单，正好当模糊匹配的压力测试

`https://api-inference.modelscope.cn/v1/models` → 200 / 3200 字节 / **35 条**，来自 **16 个 org 前缀**，
全部是 `org/Name` 命名空间（`Qwen/Qwen3.8-27B`、`deepseek-ai/DeepSeek-V4-Pro-0813`、`MiniMax/MiniMax-M3`…）。

```json
{"object":"list","data":[{"id":"deepseek-ai/DeepSeek-V4-Flash-0731","object":"","owned_by":"system","created":1785767088}, ...]}
```

**`"object": ""` 是第四种空值编码**（前三种：缺字段 / `null` / `0`）。35 条无一例外。
无任何数值字段 → 现状代码与提取器都是 0/35，属正确行为。

**拿这批 id 做匹配器压力测试**（近亲扎堆，是最坏情况）：11 条里 6 命中 5 未命中，**没有一条串行**：

| 探针 id | 联网返回 | 判定 |
|---|---|---|
| `Qwen/Qwen3.5-27B` | 262144 / 65536 | 与下条**取到不同值**，未混 |
| `Qwen/Qwen3.8-27B` | 1000000 / 131072 | ✓ |
| `Shanghai_AI_Laboratory/Intern-S1` | 未命中 | 未被 `-mini` 吸收 ✓ |
| `Shanghai_AI_Laboratory/Intern-S1-mini` | 未命中 | ✓ |
| `Shanghai_AI_Laboratory/Intern-S2-Preview` | 未命中 | ✓ |
| `XGenerationLab/XiYanSQL-QwenCoder-32B-2412` | 未命中 | 与 `-2504` 均未命中，未互串 ✓ |
| `XGenerationLab/XiYanSQL-QwenCoder-32B-2504` | 未命中 | ✓ |
| `MiniMax/MiniMax-M1-80k` | 1000000 / 40000 | ✓ |
| `MiniMax/MiniMax-M3` | 1048576 / 512000 | ✓ |
| `ZhipuAI/GLM-5.2` | 1048576 / **131072** | **与云知声自报逐字一致** ✓ |
| `deepseek-ai/DeepSeek-V4-Pro-0813` | 1048576 / **393216** | 与 intern 自报 1048576/**1048576** 冲突 |

**两个结论：**

1. **匹配器（`enrich.js:94-127`）比担心的靠谱。** 之前我怀疑双向子串会串行，这批最坏情况没复现。
   但样本仍小（11 条），且 `matchModel` 的 `q.includes(k) || k.includes(q)` 分支这次压根没被走到
   —— 命中的都是 `index[q]` 精确键或 `stripVendor` 变体键。**风险未排除，只是未命中。**
2. **hub 型平台联网覆盖率只有 ~55%**，而且缺的恰好是平台自研（`Intern-*`）和带日期别名的（`-2412/-2504`）。
   这类平台的模型参数**补不齐，只能空着或手填** —— 所以"空值不再谎标平台接口"（B 第 2 条）对它是刚需。

另外 `GLM-5.2` 这条给了一个正面样本：**联网与平台自报完全一致**，说明"降级标注"不等于"值不可用"，
标来源是为了让用户知道该信几分，不是要弃用联网那一级。

## 6. 提取器还没被真实平台命中的两个潜伏缺陷

`_variants-stress.py` 用 15 个合成 schema 变体压提取器（其中 4 个来自真实平台，11 个为构造的已知 schema 家族）：**13/15 通过**。

| 变体 | 结果 | 说明 |
|---|---|---|
| ⑥ 字符串数字 `context_length:"262144"` | **FAIL → None** | 静默取不到。SenseNova 的 `pricing` 就是字符串 `"0"`，这一派有序列化成字符串的习惯 |
| ⑦ `{"value":262,"unit":"K"}` | **FAIL → 262** | 比取不到危险 1000 倍：会写「上下文 262」并标来源可信 |

⑦ 的根因：`leaves()` 会先递归进 `{value, unit}` 包装层，等 `unwrap` 拿到手已是裸标量，**`unit` 丢失 → 护栏 2 在嵌套载荷里根本不触发**。intern-ai 那 10/10 是因为它的 unit 恰好是 `"token"`、值恰好不需换算，属运气。

通过的 13 个含：Together 派 `model_limits{}`、camelCase、`capabilities{}`、速率与上下文并存、价格含大数、只有 `name` 无 `id`、全 0/负数、哨兵超大值等。

## 7. 两个 `fetchModels` 层的结构性缺口（读代码即确认，无需实探）

- `const list = (res.body && Array.isArray(res.body.data)) ? res.body.data : []`
  → **顶层键不叫 `data` 就静默返回 0 条**，界面显示"拉取成功，0 个模型"。返回 `{"models":[...]}` 或裸数组的端点会踩中。
- `const id = String(item.id || '').trim(); if (!id) continue;`
  → **只有 `name` 没有 `id` 的端点，整条模型被丢弃**（提取器本身对这种形状是过的，是外层丢的）。

## 8. 信任序（已由用户裁定）

**平台 `/models` 自报值优先，因为它走的是该端点的官方实时通道。** 依据：
- 存在性只有 API 知道：`deepseek-v4-flash-0731`、`qwen3.8-27b`、`agnes-2.5-pro-beta`、`Atria-Dawn-Preview`、`LongCat-2.5-Preview` 这类带日期/路由别名的 id，公开目录里根本没有；联网命中的是同名模型在**别家部署**的值。
- 代码结构已支持这个语义：`enrich.js:197` 是 `m.ctx != null ? m.ctx : hit.ctx`，**联网只填空、不覆盖**。修好解析即自动获得"平台优先"，不需要任何降级启发式。
- `out == ctx`（intern 10/10、LongCat 部分）不是"官方在骗人"，是"官方没区分输入输出"。约束调用方的是这个端点自己的声明，值照用。

因此：**曾考虑的"`out==ctx` 就降级改用联网值"方案已否决**（那等于放弃实时通道换二手目录）。要改的是**来源标签**，不是值。

## 9. 待落地清单（B）

0. **`TOOL_UA` 按 host 分域**（§5b，优先级最高）：已知公开目录域不发工具 UA。
   这一条不修，OpenRouter 作为平台永远只能拿到 10 条且全空。
0b. **先定"同字段多来源冲突"规则**（§5c）：`meta-models.json` 与 `cn-models.js` 对
   `dots3-note-prev` 的 ctx 已经差 4 倍。第 1 条放宽触发判据之前必须先定这条，
   否则会把仓库内矛盾放大成静默缝合记录（`ctx 来自 meta + out 来自 cn-models + 整条标 web`）。
1. 用通用形状提取器替换硬编码字段名；同时修 §6 两个缺陷（数值字符串强转；`leaves()` 不再下钻 `{value,unit}` 包装层，使单位护栏真正生效）
2. `src` 按字段记来源（`api|meta|web|manual`），空值不再谎标「平台接口」
3. `out > ctx` 打矛盾标记（照实显示，不替换值）
4. 顶层键非 `data` / 无 `id` 只有 `name` 两种结构兜底
5. 联网检索保留，标签降为「参考·公开目录」

能力位新字段（`reasoning` / `modalities_in` / `rpm`）另开一轮，会动存储字段与导出格式。

## 10. 复现

```bash
# 需自备一次性测试密钥
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" https://token.sensenova.cn/v1/models
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" https://maas-api.unisound.com/v1/models
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" https://api.agnes-ai.cn/v1/models
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" https://discovery-api.intern-ai.org.cn/v1/models
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" https://api.longcat.chat/openai/v1/models
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" https://developer.amd.com.cn/radeon/api/v1/models
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" https://api.ant-ling.com/v1/models
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" https://api.atria-asi.ai/v1/models
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" https://api-inference.modelscope.cn/v1/models

# 小红书 Dots：证明 /models 不校验密钥（四条都应返回同一份 56 字节）
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" https://note3-prev-api.askdiandian.com/v1/models
curl -sS -H "api-key: <REDACTED-KEY>"              https://note3-prev-api.askdiandian.com/v1/models
curl -sS                                           https://note3-prev-api.askdiandian.com/v1/models
curl -sS -H "api-key: ak_wrong000"                 https://note3-prev-api.askdiandian.com/v1/models

# OpenRouter：同一把 key、同一 URL，只换 UA（§5b 的复现）
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" https://openrouter.ai/api/v1/models | python -c "import json,sys;d=json.load(sys.stdin)['data'];print(len(d),sum(1 for x in d if x.get('context_length') is not None))"   # → 465 465
curl -sS -H "Authorization: Bearer <REDACTED-KEY>" -H "User-Agent: claude-cli/1.0.23 (external, cli)" https://openrouter.ai/api/v1/models | python -c "import json,sys;d=json.load(sys.stdin)['data'];print(len(d),sum(1 for x in d if x.get('context_length') is not None))"                                        # → 10 0

# 走应用真实代码路径（看 ctx/out 被丢成什么样）
BASE=<上述 base> UK=<REDACTED-KEY> APP=<repo>/app node _runfetch.js

# 提取器原型 + 15 变体压测
python _extractor-proto.py
python _variants-stress.py
```

`_extractor-proto.py` 与 `_variants-stress.py` 是**原型/夹具**，下划线前缀标记，落地时改写进 `app/src/adapters.js` 与 `app/test/`。
