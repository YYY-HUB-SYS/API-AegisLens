# 界面重做 · 契约 v2（所有子任务必读，v1 作废）

日期：2026-10-20。目标：推翻界面视觉与结构，保留行为逻辑与后端契约。
成品要求（用户拍板）：**4 套布局 + 3 套皮肤**并存可切换，两个维度互相独立。

工作副本：`C:\Users\YQQ_Agent\Desktop\PC传输专用\API-AegisLens-src`（git 仓库，master）

---

## 一、已经做完的部分（不要重做）

1. **`app/public/app/theme.css`（已写好）** —— 皮肤层。3 套皮肤 × 明暗两态 = 6 组变量。
   选择器：`[data-skin="s1|s2|s3"][data-theme="dark|light"]`。
   **沿用仓库既有的变量名**（不是新造名字），所以 `index.html` 里已有的 CSS 与
   `renderCard()` 生成的 HTML 会自动跟随皮肤。

2. **`app/public/index.html`（已改好）** —— 接入层：
   - 启动脚本读 `localStorage['aegis-skin']` / `['aegis-layout']`，写 `html[data-skin]` / `html[data-layout]`
   - 工作区导航行右侧加了两个分段控件：`.seg-btn[data-layout="a|b|c|d"]` 与 `.seg-btn[data-skin="s1|s2|s3"]`
   - `state.layout` 字段；`applyBoardLayout()` 函数；`render()` 末尾调用它
   - `window.AegisUI` 导出内部渲染原子（`renderCard` / `keyStatus` / `balanceText` / `platLabel` /
     `shortName` / `styleShort` / `styleLabel` / `isAutoName` / `findKey` / `esc` / `ic` / `fmtDate` /
     `daysFromToday` / `fmtK` / `maskKey` / `keyMaskText` / `authNoteOf` / `ST_LABEL` /
     `LAYOUT_NAMES` / `SKIN_NAMES`；另有若干 `modelSourceLabel` 之类按存在与否自动暴露）
   - 旧的 `:root { … }` 与 `:root[data-theme="dark"] { … }` 变量块**已删除**，变量只定义在 theme.css

3. **原型工作台**（已交付，用户在看）：`C:\Users\YQQ_Agent\Desktop\PC传输专用\API-AegisLens\原型-2026-10-20_v1\`
   5 个布局方向 × 3 套皮肤的可点原型，**照着它做**，不要另起炉灶。

---

## 二、变量清单（只能用这些名，且只在 theme.css 里定义值）

`--bg --surface --surface-2 --ink --ink-2 --ink-3 --rule --rule-soft --font --display`
`--accent --accent-ink --accent-soft --accent-line --accent-line-soft`
`--api --api-soft --web --web-soft --warn --warn-soft --danger --danger-soft`
`--mono --fs-xs --fs-sm --fs-base --fs-lg --fs-xl`
`--r-card --r-ctl --r-chip --r-pill --t-fast --t --ease --z-modal --z-toast`
`--on-accent --on-danger --card-hover-border --card-hover-bg`
`--warn-line --warn-line-strong --warn-line-hover --overlay-ink --grid-line`
`--shadow-modal --shadow-toast --shadow-hover`
`--code-bg --code-ink --code-k --code-c --code-s`
`--toast-bg --toast-warn --toast-ok --toast-ink`

**禁止**在 layout.css / layout-*.css / 新的 JS 里写死 `#xxx` 颜色。

---

## 三、布局层：文件与接口

要新建的文件（各自独立，互不冲突）：

```
app/public/app/layout-shared.js   共享渲染原子（表格行 / 列表项 / 详情面板 / 紧凑卡 / 分组头）
app/public/app/layout-a.js        仪表盘
app/public/app/layout-b.js        账本
app/public/app/layout-c.js        主从
app/public/app/layout-d.js        状态列
app/public/app/layout.css         布局层公共样式（切换器样式 + 各布局共用的重置）
```

**注册方式**（`layout-a.js` 等各自只注册自己那一个，避免文件冲突）：

```js
// layout-a.js
window.BoardLayouts = window.BoardLayouts || {};
window.BoardLayouts.a = function (ctx) { return '<html>'; };
```

`ctx` 由 `index.html` 的 `applyBoardLayout()` 传入：

```js
ctx = {
  keys: state.keys,        // 全部密钥（已含平台、端点、模型、余额、状态等字段）
  platforms: state.platforms,  // 平台字典 { id: {name,color,defaultModel,endpoints,currency,auth} }
  ui: ui,                  // { collapsedGroup:{}, testing:{}, modelsLoading:{}, authOpen:{} … }
  state: state,
  api: window.AegisUI      // 内部渲染原子，见上
};
```

`ctx.keys` 的每条记录含：`id name platform customName keyMasked model reg exp authNote
endpoints[{url,style}] models[{name,ctx,out,ctxSrc,outSrc,reasoning}] balance{value,status,currency}
test{ok,at,error} assigned[{tool,host}] revoked?`

---

## 四、硬约束（违反即返工）

1. **卡片 DOM 必须保留 `class="keycard"` 与 `data-id`**。
   现有事件委托是 `btn.closest('.keycard')` 再 `findKey(card.dataset.id)`；
   单卡重绘 `rerenderCard()` 也是按 `.keycard[data-id]` 找节点。
   表格行、列表项、详情面板里的容器**也必须**带这两个属性，否则点了没反应。
2. **`data-act` 名称沿用现有实现**，不要自创：
   `test` `edit` `del` `copy` `reveal` `ep-test` `ep-models` `toggle-group` `collapse-all`
   `models` `gen` `assign` `toggle-auth` `model-list` 等。事件委托在 `index.html` 里统一处理，
   布局层**不绑定事件、不写 onclick**。
3. **不重写行为逻辑**。reveal 的取用/限流/失败提示、测试中状态、删除二次确认、模型抽屉、
   配置去向抽屉，全都在 `index.html` 的 `renderCard()` 里。**优先复用 `ctx.api.renderCard(k)`**，
   需要变体（表格行 / 紧凑卡 / 详情面板）时在 `layout-shared.js` 里基于同一批状态变量
   （`revealNote`、`ctx.ui.testing`、`ctx.ui.modelsLoading` 等）另写，但 `data-act` 与文案口径必须一致。
4. **不改 `app/src/**`**（后端）、不改 `app/server.js`、不删任何测试文件。
5. **不提交、不 push**（由总控统一提交）。
6. 窄屏 390px 不得横向溢出；动效包在 `@media (prefers-reduced-motion: no-preference)` 里；
   可点元素一律用 `button`；`:focus-visible` 要有可见焦点环。
7. 布局样式作用域用 `[data-layout="a"]` 之类，**不要**用 `.a-` 前缀类名。
   注意：旧规则 `:root[data-cols="2"] .board { columns: 2 }` 对新布局无效，
   公共重置写在 `layout.css` 里（`[data-layout] .board { display:block; columns:auto; }`）。

---

## 五、四套布局的规格

| id | 名称 | 结构 | 首屏主角 | 卡片变体 |
|---|---|---|---|---|
| `a` | 仪表盘 | 左固定导航 + 顶栏 + 统计条 + 筛选条 + 平台分组网格 | 健康度 | 完整卡 |
| `b` | 账本 | 顶栏 + 统计条 + 筛选条 + 一行一把的全宽表格，平台用小标题分组 | 可扫读 | 表格行 |
| `c` | 主从 | 窄列表（可搜索）+ 右侧详情面板，一次只展示一把 | 选中那把的完整档案 | 列表项 + 详情面板 |
| `d` | 状态列 | 统计条 + 筛选条 + 按状态分 4 列（有效/临期/过期停用/未测试） | 待处置的事 | 紧凑卡 |

**必须保留的展示信息**（少一条算功能丢失）：
平台名、密钥名、状态、余额、有效期、注册时间、掩码 Key、端点（全部）、协议风格、默认模型、
模型参数（ctx/out + 来源标记 api/web/builtin/manual）、特殊认证说明、配置去向（工具 + 哪台电脑）、
测试结果、模型数量。`compact` 变体可省注册时间与测试耗时。

**分组折叠**沿用现有机制：`data-act="toggle-group"` + `data-label="<平台名>"`，
折叠状态在 `ctx.ui.collapsedGroup[label]`，持久化在 `localStorage['aegis-collapsed']`（现有代码已处理）。

---

## 六、测试

- 现有 `app/test/workbench.test.js`（55 条）与 `app/test/homepage.test.js`（10 条）盯旧 DOM，
  结构改了就**同步更新**，**不许删测试凑绿**。
- 有 6 条样式测试因变量搬到 theme.css 而变红（主题开关令牌齐全 / CSS 变量悬空引用 /
  品牌主色对齐 logo / 字阶阶梯 / 代码面与图标 / 看板微交互）——它们只读 index.html 内联 CSS，
  要改成**同时读 `app/public/app/theme.css`**。
- 新增测试：四套布局都能渲染出关键信息、切换布局后信息不丢、皮肤切换后变量齐全。
- 收工前跑 `cd app && node --test test/*.test.js`，**必须全绿**。

---

## 七、交付回报格式

回报要含：改了哪些文件（路径 + 字节数）、测试结果（tests/pass/fail 数字）、
自测方式（怎么验证的）、**没做完或没验证的部分要明说**。
