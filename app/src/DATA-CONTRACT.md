# 数据层契约 · 表归属与字段扩展规则

日期：2026-10-21。起因：用户构想的五条线（账号密码 / API Key 管理 / 配额探测 / 模型能力 / 网关 / token 计量）
**都要往同一张 Key 表上加字段**。不先定归属，最后必然出现两张互相冲突的 Key 表。

本文件是**存储层的唯一 owner 契约**。与 `app/public/app/CONTRACT.md`（界面层契约）配套：
那份管变量与渲染原子，这份管表、字段与迁移。

---

## 一、唯一 owner：`app/src/storage.js`

**全部 8 张表只在 `app/src/storage.js` 里建，也只有它能读写它们：**

| 表 | 装什么 | 备注 |
|---|---|---|
| `keys` | 一把 API Key 的完整档案（主表） | **本项目最核心的表** |
| `models` | 每把 Key 下的模型清单与能力位 | 挂在 `keys` 上，不是全局表 |
| `assigned` | 「这把 Key 配到了哪个工具、哪台电脑」 | 多对多，独立表 |
| `history` | 每把 Key 的观测历史（测试/余额） | 每把最多 1000 条 |
| `credentials` | 账号密码保险库（网站口令/私钥/TOTP 种子） | 字段级加密 |
| `pools` + `pool_keys` | 账号池（多把 Key 归一组） | 组与成员分两张 |
| `tokens` | 消费者令牌的**签发记录** | 只存 HMAC 指纹，不存令牌本体 |

**别的模块一律不许碰 SQL。** 现状（2026-10-21 实测）：`app/src/` 下除 `storage.js` 外，
**零** `CREATE TABLE` / `INSERT` / `UPDATE` / `DELETE` 语句。
这条由 `app/test/table-ownership.test.js` 守着。

### 为什么是「唯一 owner」而不是「共享」

Key 表被四五条线同时要改。若各线自己建表、自己加列：
- 两个后端（JSON / SQLite）会**分叉** —— JSON 后端挂对象上，SQLite 后端要迁移列，
  漏一处就是「有的库有、有的库没有」；
- 字段来源（`ctxSrc` / `outSrc`）这类**跨字段约束**没法在两个地方同时表达；
- 出问题时说不清是哪条线写坏的。

所以：**要加字段，就走 `storage.js` 的方法**。这是唯一的路。

---

## 二、要给 Key 表加字段，走哪条流程

### 第 1 步：确认它属于「Key 的档案」还是「模型的属性」

这两者物理上分属两张表，别混：

- **Key 档案级**（挂在 `keys` 上）：平台、端点、余额、有效期、配置去向…
  ⇒ 加在 `storage.js` 的 `keys` 表建表语句 + JSON 后端的 `toRec`/`createKey`/`updateKey`。
- **模型属性级**（挂在 `models` 上）：上下文、输出上限、能力位、来源标记…
  ⇒ 加进 `MODEL_EXTRA` 白名单（见下）。

**判据**：这个字段描述的是「这把 Key」还是「这把 Key 下的某个模型」？
「支持视觉」是模型的属性（同一个模型在不同平台可能不同）；「平台是 anthropic」是 Key 的属性。

**一个特例：数据是账户级的，位置却是 Key 级**。`usage`（用量/限流窗口快照）
记的是**同一个平台账户**的限额 —— 同一平台的多个 Key 查出来是同一份数据。
但它挂在 `keys` 上（谁查的记谁），**不另立一张表**：
限额快照与余额（`balance`）一样是「刷新时抓一次、之后拿着快照看」的东西，
按 Key 存最省事（复用现有的按 Key 刷新流程），代价是同一账户的多个 Key 会有多份同样的快照。
界面因此**不在账号池成员行逐把显示它**（账户级的东西逐把重复显示是噪音），
只在密钥卡片上显示一处。

⇒ **两套口径不许塞进同一列**：`balance` 是钱（Key 级），
`usage` 是平台窗口（账户级快照），混在一格以后没法分别显示
「上次调用时的限额快照」和「余额」。

### 第 2 步：模型属性走 `MODEL_EXTRA` 白名单

`app/src/storage.js` 顶部的 `MODEL_EXTRA` 数组是**模型的扩展字段白名单**：

```js
const MODEL_EXTRA = ['ctxSrc', 'outSrc', 'conflict', 'outGtCtx', 'reasoning', 'modalitiesIn', 'rpm', …];
```

- **SQLite 后端**：这些字段统一存进 `models.extra` 一列 JSON。
- **JSON 后端**：直接挂在模型对象上。

**漏加一个字段的后果**（实测踩过）：SQLite 后端会**静默丢掉**它 —— 写入不报错，
读回来是 `undefined`，界面显示成「未知」。这比报错更难查。

⇒ **加模型字段必须同时做两件事**：
1. 加进 `MODEL_EXTRA`；
2. 加进 `app/test/model-fields-persist.test.js` 的 `FIELDS` 白名单
   （那张表就是「字段必须能穿过持久层往返」的守卫，漏加它 = 漏测）。

### 第 3 步：写测试

- 存储层往返：`app/test/model-fields-persist.test.js`（模型字段）、`app/test/storage.test.js`（Key 字段）
- 两个后端都要跑：JSON 与 SQLite 行为必须一致
- 行尾 CRLF：加完字段核对 `loneLF === 0`

---

## 三、字段来源标记：每个值都要能说清是哪来的

模型的能力值有四个来源，**可信度不同**，界面必须能分开呈现：

| 来源标签 | 含义 | 可信度 |
|---|---|---|
| `api` | 平台自己接口报的 | 最高 |
| `manual` | 用户手填的 | 高（用户明确指定） |
| `meta` | 内置元数据库查的 | 参考 |
| `web` | 联网检索公开目录查的 | 参考（最低） |

**「参考」这一档有个硬事实**：模型限制是 **(平台端点, 模型) 的二元事实**，不是模型的全局属性。
实测（`app/test/fixtures/model-responses/FINDINGS.md`）：`kimi-k2.6` 在云知声 out=16000、
intern-ai out=262144，**差 16.4 倍**。⇒ 任何「按模型 id 全局查表」只能给**参考值**，
不能覆盖平台自报值。

字段来源的标记方式：
- `ctxSrc` / `outSrc` —— 记**级别**（`api` / `meta` / `web` / `manual`）
- `ctxFrom` / `outFrom` —— 记**具体出处**（`openrouter` / `modelsdev` / `builtin-cn`）

两者不能混：级别决定「能不能信」，出处决定「从哪查的」。

---

## 四、跨表引用的边界

- `models.key_id` → `keys.id`：**一对多**。删 Key 时级联删它的 models / assigned / history。
- `pool_keys` → `keys.id` + `pools.id`：**多对多**。池子里的成员是 id 列表，
  展示时才现取完整 Key 记录（`api.js` 的 `poolWithKeys`）——
  **不要在池子里存 Key 副本**，那会绕过掩码视图。
- `tokens.key_ids_json` / `cred_ids_json`：**枚举不是通配**。空清单 = 一条都读不到。
- `history.key_id` → `keys.id`：观测记录，主 Key 删了就没意义。

**跨表引用的 id 一律是 `keys.id`，不要用别的编号体系**（比如平台 id、tid）。
`tokens.tid` 是**令牌自己的 id**，跟 `keys.id` 是两回事，别混。

---

## 五、改这张表时必须想到的三个坑

1. **两个后端要一起改**。JSON 后端挂对象、SQLite 后端建列或进 `extra`。
   只改一个 = 换台机器 / 换个 Node 版本，字段凭空消失。
   （本项目 Node 22+ 走 SQLite、18–21 走 JSON，两边**互不迁移**。）

2. **别建第二张 Key 表**。要加维度就加字段或加关联表
   （像 `assigned` 那样），不要 `key_meta` / `keys_v2` —— 那是两张互相冲突的 Key 表的开端。

3. **加字段前先问「谁读它」**。加了没人读的字段是负债：
   `models` 表里就有个前例 —— 界面上的「模型清单」入口曾经没有，字段白存。
   （反过来，`app/src/api.js` 的 `GET /api/keys/:id/history` 有接口无入口，
   那不是字段的问题，是没人接线 —— 但同样说明「加了要接」。）

4. **SQLite 加列必须配幂等的 `ALTER TABLE`**（2026-10-21 实测踩过，是 P0）。
   `CREATE TABLE IF NOT EXISTS` **只对新库生效** —— 老库上那张表早就存在，
   `IF NOT EXISTS` 变成空操作，新列根本没加上。
   不补 `ALTER TABLE` 的话，老库不是「用到那张表才出问题」，
   而是**一打开就在 `db.prepare(...)` 那一行抛 `no such column`，服务根本起不来**。
   而且**新库全绿、老库炸**：测试几乎都用新建的临时库，
   所以必须专门造一个**老 schema 的库**来测升级路径。
   写法：`try { db.exec('ALTER TABLE keys ADD COLUMN x TEXT'); } catch (e) { /* 已有 */ }`

5. **建表语句里的列容易插错表**（同一批踩的）。
   一次给 `models` 表加列时，`role` / `sort_index` 被插进了 `models`
   —— 那是 `pool_keys` 的列。改完**逐表核对列落在哪**
   （`PRAGMA table_info(t)`），别看着建表语句「像是对的就过了」。

6. **别把 `SELECT` 写进本项目的表**。`app/src/token-usage.js` 读的是**别的应用**
   （本机几个 AI agent）自己的 sqlite 库，用的是 `DatabaseSync(p, {readOnly:true})`，
   只 `SELECT`、用完 `close()`、**不碰对方的对话内容**。
   它不属于「本项目的表」，所以不受本契约的 owner 约束；
   但「只读、只出数字、句柄要关」这三条是硬要求。

---

## 六、守卫测试

`app/test/table-ownership.test.js` 守着本契约：

- 全部 `CREATE TABLE` 必须且只能在 `app/src/storage.js` 里；
- 别的模块不许出现 `CREATE TABLE` / `INSERT INTO` / `UPDATE … SET` / `DELETE FROM`；
- `MODEL_EXTRA` 里的每个字段都必须在 `model-fields-persist.test.js` 的 `FIELDS` 里登记
  （两张白名单必须一一对应，漏一个就红）；
- `MODEL_EXTRA` 里的字段必须在界面上有出口（`capChips` 或 `srcChips` 读得到）。

改这张表时，**先跑一遍这条测试**。
