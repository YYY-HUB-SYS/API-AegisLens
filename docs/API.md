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
| `GET` | `/api/keys/{id}/history?kind=test\|balance` | 观测历史。每把 Key 保留最近 1000 条,默认读回 200 条。**界面上暂无入口** |
| `POST` | `/api/refresh-balances` | 批量刷余额 |
| `GET` | `/api/platforms` | 内置平台目录(13 家 + custom) |
| `GET` | `/api/meta` | 版本、元数据库日期、存储后端、数据目录、本机名、影子库 |

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
| `PUT` / `DELETE` | `/api/pools/{id}` | 改名 / 删除 |
| `POST` | `/api/pools/{id}/keys` | 加入成员 |
| `DELETE` | `/api/pools/{id}/keys/{keyId}` | 移出成员 |

`GET /api/pools` 返回的成员走的是和 `GET /api/keys` **同一套掩码视图**;
保险库锁着时同样 `423`。

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
| `POST` | `/api/vault/recover` | 用 52 位恢复码重置口令,同时轮换恢复码  失败计入自己的独立限流桶 |
| `POST` | `/api/vault/discard-master-key` | 拆除明文 DEK 副本。**不可逆**;免口令安装下会被拒绝 |

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

scope 共 4 个;资源清单是**枚举**——清单为空就是什么都拿不到,不是"全部"。
签发时服务端按请求原样存 payload:勾了 scope 却不选资源,签出来的是一把读不到东西的令牌(**空资源清单 = 零把可读**,不是"全部可读")。浏览器的签发表单会拦这种情况,脚本直调 API 不会。
上限:label 40 字符、资源 id 合计 64、有效期 60 秒 ~ 90 天(默认 30 天)。
状态码:`423` 保险库锁着(不告诉你令牌对不对)、`401` 令牌缺失/无效/过期/已吊销、`403` scope 不够、`429` 过于频繁(带 `retryAfterMs`)。
吊销检查排在 scope 检查**之后**:已吊销的令牌若用错 scope 的端点访问,拿到的是 `403` scope 而不是 `401` revoked——要确认一把令牌是否被吊销,得用一把 scope 匹配的令牌去调。

## 定时调度

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/schedule` | 当前状态 |
| `POST` | `/api/schedule` | 运行时开关;**不持久**,重启回到环境变量的值。**界面上无开关** |

## 导入 / 导出

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/import` | 收 `{keys:[…]}`;`type` 字段只在前端校验(见 README 已知限制) |

导出在前端完成:默认**不含** `key` 字段;勾选「包含明文密钥」后才逐条调用 reveal。

## 数字一览

| 项 | 值 | 出处 |
|---|---|---|
| 路由总数 | 48(方法+路径组合;去重后 38 条路径形状) | `app/src/api.js`、`credentials-api.js`、`consumer-api.js` |
| 界面动作 | 69 个 `data-act` | `app/public/*.js`、`app/public/index.html` |
| 内置平台 | 13 家 + custom | `app/src/platform-catalog.json` |
| 每把 Key 端点上限 | 6(前后端各一道) | `index.html` 的 `MAX_EPS`、`adapters.js` 的字面量 6 |
| 口令长度 | 最短 8 位、最长 1024 位 | `crypto.js` |
| KDF | scrypt `N=32768, r=8, p=1` | `crypto.js` |
| 恢复码 | 52 字符(base32,256 位) | `recovery.js` |
| 闲置自动锁 | 默认 5 分钟 | `AKM_IDLE_LOCK_MINUTES` |
| 限流(失败次数 / 锁窗口 5 分钟) | 解锁 5、**恢复码 5(独立桶)**、Key 揭示 30(**按密钥 id 分桶**)、凭证 20、令牌签发 20、改口令 5 | `server.js` |
| 限流(请求次数 / 滑窗 60 秒) | 消费者数据面 **120**(按令牌分桶;401/403/404/423 不计数) | `consumer-api.js` |
| 明文自动收回 | 30 秒;切走标签页立即收回 | `credentials-view.js` |
| 观测历史 | 每把 Key 1000 条,默认读回 200 | `storage.js` |
