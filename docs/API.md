# 接口与限制一览 / API & limits

> 这份是**参考手册**,不是入门文档。第一次接触本项目请看 [README](../README.md);
> 部署看 [DEPLOYMENT](../DEPLOYMENT.md);安全边界看 [SECURITY](../SECURITY.md)。
>
> 里面每条路径、每个数字都从代码里数出来,并由 `app/test/docs.test.js` 对着源码复核
> (写了代码里不存在的接口、或数字与代码不符,测试会红)。英文版见 [API_EN.md](./API_EN.md)。

## 密钥与看板

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/keys` | 列表。**只出末 4 位**,不含密文 |
| `GET` | `/api/keys/{id}` | 单条。**只出末 4 位**,不含密文;要明文走 `POST /api/keys/{id}/reveal` |
| `POST` | `/api/keys` | 新增 |
| `PUT` | `/api/keys/{id}` | 修改 |
| `DELETE` | `/api/keys/{id}` | 删除 |
| `POST` | `/api/keys/{id}/reveal` | 取该把 Key 的明文;需已解锁会话,单独限流并记审计 |
| `POST` | `/api/keys/{id}/test` | 连通性测试,可带 `endpointIndex` 指定测第几条端点 |
| `GET` | `/api/keys/{id}/history?kind=test\|balance\|usage` | 观测历史。每把 Key 保留最近 1000 条,默认读回 200 条。`usage` 是限额快照的历史（一个窗口一行） |
| `POST` | `/api/refresh-balances` | 批量刷余额 |
| `POST` | `/api/keys/{id}/usage` | 查这把 Key 的**限额快照**(用量/限流窗口)。**账户级**数据,快照挂在查询的这把 key 上 |
| `POST` | `/api/refresh-usage` | 批量刷限额快照。响应 `{keys, updated, failed, skipped}`;`skipped` 是没有公开接口的平台数 |
| `GET` | `/api/platforms` | 内置平台目录(13 家 + custom) |
| `GET` | `/api/meta` | 版本、元数据库日期、存储后端、数据目录、本机名、影子库 |

### 余额与限额快照:两套口径,不要混

界面上这两格是**不同的东西**,不能都叫「配额」:

| | 是什么 | 粒度 | 界面上怎么写 |
|---|---|---|---|
| **余额** | 账户里还剩多少钱 | Key 级 | `余额 ￥12.34` + `· 10-21 13:05 查到` |
| **限额快照** | 平台报的窗口限额(5 小时还剩几次、30 天配额) | **账户级** | `限额快照 · 5 小时窗口已用 1200/1500` + `· 10-21 13:05 查到` |

- 限额快照必须写「**快照**」并带时间:那是**上次查询时**的读数,不是此刻的。
  写成「剩余积分 300 次」是骗人 —— 那个数下一秒就变了。
- 三态要分得清:`查到了快照` / `没查过` / `该平台不提供公开接口`。
  「没测过」≠「无限」≠「没有数据」。
- 平台不公开接口时(如商汤日日新、美团 LongCat),额度只能在厂商控制台看 ——
  这种情况**如实说**,不要笼统报「查询失败」。
- 认证失败与解析失败是两回事:智谱(`body.code`)与 MiniMax(`body.base_resp.status_code`)
  把认证失败包在 **HTTP 200** 里,不先判平台错误码就会把「密钥无效」报成
  「平台返回了余额数据但没解析出金额」。

已接余额接口的平台（7 家）:DeepSeek、Moonshot·Kimi、智谱、阶跃星辰、硅基流动、OpenRouter、Novita。
已接限额接口的平台（3 家）:智谱(`{origin}/monitor/usage/quota/limit`,`{origin}` 即该厂商的 API 根地址)、MiniMax(`/v1/token_plan/remains`)、
Anthropic(`/v1/organizations/usage/costs`,**要组织管理员密钥**,普通项目密钥会 403)。

**查不到时的原因要说准**：「接口存在但凭据类型不对」≠「平台压根没这个接口」。
`POST /api/keys/{id}/usage` 在没有公开限额接口时回 `400`,文案按平台给：

- OpenAI:用量接口只对**组织管理员**开放（要 admin key）
- xAI:账单接口在 `management-api.x.ai`,只认 **management key**（`sk-` 推理 key 会被拒）
- 火山方舟:`GetInferenceUsage` / `ListModelRateLimit` 只认 **Access Key 签名**
- 其余平台:这个平台没有公开的用量/限额接口,额度只能在厂商控制台看

出站**没配代理**时,网络失败/超时的文案会带一句提示（设 `AKM_PROXY=http://127.0.0.1:7897` 后重启）；
配了代理就不提 —— 那时超时不是代理的锅。

### 端点(models)

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/keys/{id}/models` | 手动添加模型 |
| `POST` | `/api/keys/{id}/models/fetch` | 从平台 `/models` 拉清单 |
| `POST` | `/api/keys/{id}/models/enrich` | 补齐缺参数的模型:内置元数据库 → 联网检索公开目录 |
| `PATCH` | `/api/keys/{id}/models/{modelId}` | 改单条参数。**只改已存在的行**,不存在返回 404 |

字段来源共 6 个值:`api` / `meta` / `web` / `builtin` / `manual` / `unknown`;
按字段各有一份 `ctxSrc` / `outSrc`,人改过的字段在重新拉取后保留。
能力位:`reasoning`、`modalitiesIn`、`rpm`,以及 `outGtCtx`、`conflict` 两个告警位。

### 去向记录

一条去向 = `{tool, host}`：工具名 + 哪台电脑。同一工具可以登记在多台电脑上；
老数据（纯字符串数组）读入时自动归一为 `host: ""`（不知道哪台电脑）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/keys/{id}/assigned` | 记一把 Key 配进了哪个工具；体 `{tool, host}`，`host` 留空 = 这台电脑 |
| `DELETE` | `/api/keys/{id}/assigned/{tool}?host=` | 取消；带 `host` 只取消那一台，缺省 = 所有电脑一并取消 |

## 账号池

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` / `POST` | `/api/pools` | 列表 / 新建(名称唯一,≤40 字符) |
| `GET` / `PUT` / `DELETE` | `/api/pools/{id}` | 单个池详情 / 改名 / 删除 |
| `POST` | `/api/pools/{id}/keys` | 加入成员 |
| `DELETE` | `/api/pools/{id}/keys/{keyId}` | 移出成员 |
| `POST` | `/api/pools/{id}/rotate` | 轮换:把当前生效的那把换成备用队列里第一把健康的 |

`GET /api/pools` 返回的成员走的是和 `GET /api/keys` **同一套掩码视图**;
保险库锁着时同样 `423`。

### 池成员的三种身份

| 身份 | 字段 | 含义 |
|---|---|---|
| 当前生效 | `role: "active"` | 一把池最多一把。建池时队首那把就是它 |
| 备用队列 | `role: "backup"` | 按 `sortIndex` 排队,轮换时按这个顺序接班 |
| 排队次序 | `sortIndex` | 当前生效那把固定占 `0`,备用从 `1` 起连续 —— `0` 是 active 的位置,备用不占 |

改成员名单时**不换当前生效那把**:它还在名单里就还在,不在了才让队首那把顶上。
删掉的正好是当前生效那把时,备用队首提上来(否则池子会变成「一把都不能用」)。

### 健康快照

每把密钥带两个健康字段(`failCount` / `lastHealthAt`),跟着「测试」结论走:
通过 ⇒ 连续失败次数归零;失败 ⇒ 加一;测过 ⇒ 刷新时间。

**不健康 = 连续失败 ≥2 次**。没测过的不算不健康 —— 没测过不等于坏了,
所以没测过的密钥照样算「能接班」,轮换挑备用时按这条判。

`GET /api/pools/{id}` 与轮换的响应都带 `health[]`:每个成员一条
(`keyId` / `name` / `role` / `failCount` / `lastHealthAt` / `lastStatus` / `healthy`),
**不含密钥明文**。

### 轮换

`POST /api/pools/{id}/rotate`,请求体可选:

- 不带 body:按备用队列顺序,切到第一把健康的;
- 带 `{"toKeyId": N}`:切到指定那把(必须在这个池子里,否则 `400`)。
  指定轮换不拦健康 —— 操作者明确指名的就照做。

响应 `{ ok, changed, pool, rotatedFrom, rotatedTo, skipped }`,
`skipped` 是被跳过的那些不健康的备用(只记考察过的)。
切到已经在用的那把是**幂等**的:返回 `200` 与 `changed:false`,状态不动。
备用队列里一把健康的都没有 ⇒ `400`「备用队列里没有健康的密钥」。

轮换会留审计(`kind: rotate`),**只记密钥 id,不记任何明文**。

## 凭证保险库

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` / `POST` | `/api/credentials` | 列表 / 新建（`site` 必填：清单按网站分组） |
| `GET` | `/api/credentials/health` | 用户名复用、弱口令、超期统计。**不含任何口令内容** |
| `GET` / `PUT` / `DELETE` | `/api/credentials/{id}` | 读(掩码)/ 改 / 删 |
| `POST` | `/api/credentials/{id}/reveal` | 唯一明文出口:`password` `secret` `note` `totpSecret` |
| `GET` | `/api/credentials/{id}/totp` | 实时验证码 + `step` / `digits` / `algorithm` / `secondsRemaining` |
| `GET` | `/api/credentials/{id}/password-policy` | 该站点的口令规则(数据来自 Apple 公开规则表) |

字段上限:网站/标题各 200、用户名/网址/文件夹各 500、标签最多 12 个 × 40 字、口令 512、私钥 512、TOTP 种子 1024、备注 4000；登录方式为五值枚举（password / oauth / sms / scan / other）。
TOTP 种子可以是裸 Base32,也可以是整条 `otpauth://` URI(此时 `period` / `digits` / `algorithm` 以 URI 为准)。

## 保险库会话

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/vault/status` | `unlocked` / `mode` / `passphraseSet` / `rawKeyPresent` / `needsSetup` / `idleRemainingMs` / `recent`(最近 8 条审计) |
| `POST` | `/api/vault/unlock` | 解锁。失败计入限流  与恢复码**独立分桶**:输错恢复码不会连带把解锁门锁上 |
| `POST` | `/api/vault/lock` | 立即锁定(同时关闭存储) |
| `POST` | `/api/vault/passphrase` | 设 / 改口令。改时要验 `current` |
| `POST` | `/api/vault/recover` | 用 52 位恢复码重置口令,同时轮换恢复码  失败计入自己的独立限流桶  成功后**作废所有旧令牌**(清空签发记录,响应带 `tokensRevoked`);密钥/凭证/账号池一条不动 |
| `POST` | `/api/vault/discard-master-key` | 拆除明文 DEK 副本。**不可逆**;免口令安装下会被拒绝 |
| `POST` | `/api/vault/master-key-location` | 主密钥在「数据目录明文文件」与「系统凭据管理器」之间搬动,body `{target:"os"|"file"}`。**可逆**;搬到 `os` 后数据目录里只剩不含密钥的占位文件,拷走目录拿不到钥匙。需系统凭据管理器可用(装可选依赖 `@napi-rs/keyring`),否则 400 |

## 机器消费者令牌

管理面(浏览器里用,需同源写请求):

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/consumer/tokens` | 列表,只含元数据 |
| `POST` | `/api/consumer/tokens` | 签发。**明文令牌只在这一次返回**,库里只存 HMAC 指纹前 8 位 |
| `POST` | `/api/consumer/tokens/{tid}/revoke` | 吊销 |

机器面(Bearer 令牌调用):

| 方法 | 路径 | 需要的 scope |
|---|---|---|
| `GET` | `/api/consumer/keys/{id}` | `key:read` |
| `POST` | `/api/consumer/keys/{id}/test` | `key:test` |
| `GET` | `/api/consumer/keys/{id}/balance` | `balance:read` |
| `GET` | `/api/consumer/credentials/{id}` | `cred:read` |

scope 共 5 个;资源清单是**枚举**——清单为空就是什么都拿不到,不是"全部"。
签发时服务端按请求原样存 payload:勾了 scope 却不选资源,签出来的是一把读不到东西的令牌(**空资源清单 = 零把可读**,不是"全部可读")。浏览器的签发表单会拦这种情况,脚本直调 API 不会。
上限:label 40 字符、资源 id 合计 64、有效期 60 秒 ~ 90 天(默认 30 天)。
状态码:`423` 保险库锁着(不告诉你令牌对不对)、`401` 令牌缺失/无效/过期/已吊销、`403` scope 不够、`429` 过于频繁(带 `retryAfterMs`)。
吊销检查排在 scope 检查**之后**:已吊销的令牌若用错 scope 的端点访问,拿到的是 `403` scope 而不是 `401` revoked——要确认一把令牌是否被吊销,得用一把 scope 匹配的令牌去调。
令牌的有效性有两道闸:验签(DEK 派生)与**签发记录**(库里那张 tokens 表)。用恢复码重置口令走的是第二道闸——DEK 没换、密文一条没动,但签发记录被整张清空,旧令牌一律 `401`(`reason: unknown`),要重新签发。

## 本地网关(数据面)

别的 OpenAI 兼容客户端(Dify / n8n / Claude Code / Cherry Studio)拿一把**消费者令牌**
就能调用本机账号池里的厂商密钥:客户端只看到自己的令牌,厂商密钥由服务端从池里取。

| 方法 | 路径 | 需要的 scope |
|---|---|---|
| `POST` | `/api/proxy/v1/chat/completions` | `proxy:invoke` |
| `GET` | `/api/proxy/v1/models` | `proxy:invoke` |

- **`proxy:invoke` 绑现有的 `keyIds` 资源清单**:令牌列了哪些 key,代理就只用这些;
  没列时才回退到「池里当前生效的那把」。
  **payload 的形状没动** —— 加一个字段会让所有已签发的老令牌全部验签失败。
- 选 key 的顺序:池内 `role=active` 的当前生效那把排最前,其余按备用队列顺序;
  **连续失败 ≥2 次的跳过**(没测过的不算坏)。
- 厂商返回 401 / 429 / 5xx 或超时时,**自动换下一把重试**;全失败返回 `502`,
  并说清试了几把、每把什么原因 —— 绝不装成成功。换过 key 记进审计。
- **绝不出现在响应里的东西**:厂商密钥的明文、请求体(prompt / messages)。
  审计只记元数据(令牌指纹、池 id、模型、换了几把、HTTP 状态、token 用量)。
- 限流单独一档:**每把令牌 60 次 / 60 秒**;上游超时 120 秒 / 一次尝试,
  整条请求 5 分钟总预算;请求体上限 1 MiB(超限 `413`)。
- 本版本**不支持流式**(`stream:true` 明确回 `400`,不静默降级)。
- 跨源写请求一律 `403`。

## 本机用量

`GET /api/local-usage?days=30&sources=1`

读本机几个 AI 编程 agent（MiniMax Code / cc-switch / WorkBuddy AI）**自己记的账**，汇总成按天 / 按模型 / 按 agent 的用量。

- **只出数字与模型名**：不读对话内容、不带出任何会话标题，也不出这台机器的路径。
  采集是**只读**打开对方的 sqlite 库、用完就关；源格式变了或读不到就降级成空结果，不会 500。
- **两套口径分开**：消耗（token 数、花费）与上下文占用（当前窗口占了多少）**不是一回事**，
  响应里分别是 `totals` 与 `context`，别混着说。
- 保险库锁着时 `423`；限流 60 次 / 60 秒；结果在进程内缓存 5 秒。
- 界面入口：顶栏「本机用量」。

## 定时调度

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/schedule` | 当前状态 |
| `POST` | `/api/schedule` | 运行时开关;**不持久**,重启回到环境变量的值。**界面上无开关** |
| `POST` | `/api/schedule/run` | **立即跑一轮**(每把 Key 测一次 + 批量刷余额)。**会真的朝厂商发请求**,所以要已解锁;单独限流 5 次/小时。跑完的结果会写进「上次运行」 |

## 导入 / 导出

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/import` | 收 `{keys:[…]}`;`type` 字段只在前端校验(见 README 已知限制) |

导出在前端完成:默认**不含** `key` 字段;勾选「包含明文密钥」后才逐条调用 reveal。

## 数字一览

| 项 | 值 | 出处 |
|---|---|---|
| 路由总数 | 57(方法+路径组合;去重后 46 条路径形状) | `app/src/api.js`、`credentials-api.js`、`consumer-api.js`、`proxy-api.js` |
| 界面动作 | 77 个 `data-act` | `app/public/*.js`、`app/public/index.html` |
| 内置平台 | 13 家 + custom | `app/src/platform-catalog.json` |
| 每把 Key 端点上限 | 6(前后端各一道) | `index.html` 的 `MAX_EPS`、`adapters.js` 的字面量 6 |
| 口令长度 | 最短 8 位、最长 1024 位 | `crypto.js` |
| KDF | scrypt `N=32768, r=8, p=1` | `crypto.js` |
| 恢复码 | 52 字符(base32,256 位) | `recovery.js` |
| 闲置自动锁 | 默认 5 分钟 | `AKM_IDLE_LOCK_MINUTES` |
| 限流(失败次数 / 锁窗口 5 分钟) | 解锁 5、**恢复码 5(独立桶)**、Key 揭示 30(**按密钥 id 分桶**)、凭证 20、令牌签发 20、改口令 5 | `server.js` |
| 限流(请求次数 / 滑窗 60 秒) | 消费者数据面 **120**(按令牌分桶;401/403/404/423 不计数) | `consumer-api.js` |
| 限流(请求次数 / 滑窗 60 分钟) | 手动触发跑一轮 **5**(按来源 IP 分桶;这一按会真的朝厂商发请求) | `server.js` |
| 明文自动收回 | 30 秒;切走标签页立即收回 | `credentials-view.js` |
| 观测历史 | 每把 Key 1000 条,默认读回 200 | `storage.js` |
