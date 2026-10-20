/* API-AegisLens · 主视图（layout-main.js）
   ------------------------------------------------------------------
   收敛后的唯一一套看板：左边按平台分组的紧凑列表，右边选中那把的完整档案。

   为什么只剩这一套：
   之前四套布局（仪表盘 / 账本 / 主从 / 状态列）并存，外加一个「布局」切换器，
   每次打开都要先决定用哪个模式 —— 设计决策被推给了使用者。现在只有一个视图，
   四个场景各就各位：
     扫读 = 左列表的紧凑行（平台色点 + 名称 + 状态 + 掩码 + 端点数 + 默认模型 + 余额/有效期）
     聚焦 = 点左列表任意一行，右边换成那把密钥的完整档案
     巡检 = 顶部筛选条（全部 / 有效 / 临期 / 过期停用）+ 行上的状态徽章 + 组头的状态计数
     分组 = 左列表按平台分组，组头可折叠（收起全部 / 展开全部在顶部筛选条上）

   硬约束（契约 v2，见 CONTRACT.md）：
   - 承载业务动作的容器必须带 class="keycard" 与 data-id，否则 index.html 的事件委托
     （btn.closest('.keycard') → findKey(card.dataset.id)）找不到密钥，点什么都没反应。
   - 业务动作只出 data-act，布局层不绑事件、不写 onclick；事件委托在 index.html 里统一处理。
     只有搜索框与选中切换这类纯布局交互由本文件自己绑，且一律不带 data-act。
   - 状态判定一律走 ctx.api.keyStatus(k)（ok / warn / exp / revoked）。
     「未测试」只是「这把还没测过连通」这个事实，不是一列，也不跟「有效」抢同一批密钥：
     行上给它一个「未测」标记，计数口径与顶部统计条同源（同一套 keyStatus、同一份数据）。
   - 颜色只用 theme.css 的变量，不写死 #xxx。
   - 样式作用域锁在自己的根容器 .px-main 上（index.html 已经不再写 data-layout 属性了）。

   依赖 window.LayoutShared（共享渲染原子，接口见契约 v2）。
   共享层没就位时退回 index.html 的完整卡，界面不至于空着。 */

(function () {
  'use strict';

  /* ================= 样式 ================= */

  var STYLE_ID = 'al-layout-main-style';

  var CSS = [
    /* index.html 的 :root[data-cols="2"] .board { columns: 2 } 还在生效
       （data-layout 属性已被删，layout.css 里那条公共重置匹配不上了）。
       不撤掉的话整个主视图会被塞进多栏流的第一栏，右边详情面板直接被挤没。
       html #board.board 是 (1,1,1)，压得过 :root[data-cols="2"] .board 的 (0,3,0)。 */
    'html #board.board { display: block; columns: auto; column-gap: normal; }',

    /* ---- 根骨架：左列表 + 右详情 ---- */
    '.px-main {',
    '  display: grid;',
    '  grid-template-columns: minmax(272px, 344px) minmax(0, 1fr);',
    '  gap: 14px;',
    '  align-items: start;',
    '  min-width: 0;',
    '}',
    /* 详情面板在 DOM 里排在前面：index.html 的 rerenderCard() 用
       document.querySelector('.keycard[data-id]') 只改第一个命中的节点。
       详情在前，被整卡重绘的就是详情面板（信息完整）；
       列表行不会突然被换成一张完整卡。视觉上靠 grid-column 摆回右边。 */
    '.px-main .px-detail { grid-column: 2; grid-row: 1; min-width: 0; }',
    '.px-main .px-listpane { grid-column: 1; grid-row: 1; min-width: 0; }',
    '.px-main .px-detail, .px-main .px-listpane { overflow-wrap: break-word; }',

    /* 列表面板：独立滚动，粘在顶上 */
    '.px-listpane {',
    '  position: sticky; top: 8px;',
    '  background: var(--surface);',
    '  border: 1px solid var(--rule);',
    '  border-radius: var(--r-card);',
    '  padding: 9px 10px 10px;',
    '  max-height: calc(100vh - 132px);',
    '  overflow: auto;',
    '  overscroll-behavior: contain;',
    '}',
    '.px-pane-head { display: flex; align-items: center; gap: 8px; padding: 2px 3px 8px; }',
    '.px-pane-title { font-size: var(--fs-sm); font-weight: 700; color: var(--ink-2); }',
    '.px-count {',
    '  margin-left: auto; font-size: var(--fs-xs); color: var(--ink-3);',
    '  font-variant-numeric: tabular-nums;',
    '}',
    '.px-search { padding-bottom: 8px; }',
    '.px-search-input {',
    '  width: 100%; min-width: 0;',
    '  border: 1px solid var(--rule); background: var(--surface-2); color: var(--ink);',
    '  font: inherit; font-size: var(--fs-sm);',
    '  border-radius: var(--r-ctl); padding: 6px 9px;',
    '}',
    '.px-search-input::placeholder { color: var(--ink-3); }',
    '.px-search-input:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 1px; }',
    '.px-groups { display: flex; flex-direction: column; gap: 10px; }',
    '.px-group { min-width: 0; }',
    '.px-rows { display: flex; flex-direction: column; gap: 2px; }',

    /* ---- 行：一行一把，字段克制 ---- */
    /* 容器带 .keycard 是硬约束（事件委托靠它找记录），但卡片那套边框、留白、
       悬停抬升放进列表里全是噪音，抹平：.keycard.px-row 是 (0,2,0)，
       压得住 .keycard 的 (0,1,0)，不靠文件加载顺序。 */
    '.keycard.px-row {',
    '  display: grid; gap: 3px;',
    '  width: 100%; min-width: 0;',
    '  text-align: left;',
    '  font: inherit; color: inherit;',
    '  background: transparent;',
    '  border: 1px solid transparent; border-radius: var(--r-ctl);',
    '  padding: 7px 9px;',
    '  cursor: pointer;',
    '  box-shadow: none;',
    '  transition: none;',
    '}',
    '.keycard.px-row:hover {',
    '  background: var(--surface-2); border-color: var(--rule);',
    '  box-shadow: none; transform: none;',
    '}',
    '.keycard.px-row.px-row-on { background: var(--accent-soft); border-color: var(--accent-line); }',
    '.keycard.px-row:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 1px; }',
    '.px-row-top { display: flex; align-items: center; gap: 6px; min-width: 0; }',
    '.px-row-top .plat-dot { flex-shrink: 0; }',
    '.px-row-name {',
    '  font-size: var(--fs-sm); font-weight: 600; min-width: 0;',
    '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
    '}',
    '.px-row-meta {',
    '  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;',
    '  font-size: var(--fs-xs); color: var(--ink-3); min-width: 0;',
    '}',
    '.px-row-mask { font-family: var(--mono); }',
    '.px-row-model {',
    '  font-family: var(--mono); max-width: 15ch;',
    '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
    '}',
    '.px-row-money { font-variant-numeric: tabular-nums; }',
    /* 「还没测过连通」是标记，不是状态列：它不跟「有效」抢密钥，只标出这把没测过。 */
    '.px-untested {',
    '  font-size: var(--fs-xs); color: var(--ink-3);',
    '  border: 1px dashed var(--rule); border-radius: var(--r-chip);',
    '  padding: 0 6px; flex-shrink: 0;',
    '}',

    /* ---- 组头的状态计数：与顶部统计条同源（同一套 keyStatus、同一份数据） ---- */
    '.px-tally { display: inline-flex; align-items: center; gap: 6px; }',
    '.px-tally-item {',
    '  font-size: var(--fs-xs); font-variant-numeric: tabular-nums;',
    '  border-radius: var(--r-chip); padding: 1px 7px;',
    '}',
    '.px-tally-item.ok { color: var(--api); background: var(--api-soft); }',
    '.px-tally-item.warn { color: var(--warn); background: var(--warn-soft); }',
    '.px-tally-item.exp { color: var(--danger); background: var(--danger-soft); }',

    /* ---- 空态 ---- */
    '.px-empty {',
    '  padding: 20px 12px; text-align: center;',
    '  border: 1px dashed var(--rule); border-radius: var(--r-ctl);',
    '  color: var(--ink-3); font-size: var(--fs-sm);',
    '}',
    '.px-empty-t { color: var(--ink-2); font-weight: 600; }',
    '.px-empty-s { margin-top: 4px; font-size: var(--fs-xs); }',

    /* 详情面板是静态档案，不跟着鼠标抬：去掉 .keycard 的悬停抬升与投影 */
    '.px-main .keycard.lm-detail:hover {',
    '  border-color: var(--rule); background: var(--surface);',
    '  box-shadow: none; transform: none;',
    '}',

    /* ---- 动效：只在用户没要求减少动效时开 ---- */
    '@media (prefers-reduced-motion: no-preference) {',
    '  .keycard.px-row {',
    '    transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);',
    '  }',
    '}',

    /* ---- 窄屏：主从折成一列，列表在上、详情在下；390px 不许横向溢出 ---- */
    '@media (max-width: 880px) {',
    '  .px-main { grid-template-columns: minmax(0, 1fr); gap: 12px; }',
    '  .px-main .px-detail { grid-column: 1; grid-row: 2; }',
    '  .px-main .px-listpane {',
    '    grid-column: 1; grid-row: 1; position: static; max-height: 340px;',
    '  }',
    '}'
  ].join('\n');

  function installStyle() {
    if (typeof document === 'undefined' || !document.createElement) return;
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    (document.head || document.documentElement).appendChild(el);
  }

  /* ================= 工具 ================= */

  function shared() {
    return (typeof window !== 'undefined' && window.LayoutShared) ? window.LayoutShared : null;
  }

  function escOf(ctx, s) {
    var api = ctx && ctx.api;
    if (api && typeof api.esc === 'function') {
      try { return api.esc(s); } catch (e) { /* 落到本地 */ }
    }
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 状态判定只有一个出处：ctx.api.keyStatus（index.html 的那一个）。
     自己另判一遍就会跟顶部统计条分叉 —— 上一版栽的就是这个。 */
  function statusOf(ctx, k) {
    var api = ctx && ctx.api;
    if (api && typeof api.keyStatus === 'function') {
      try { return api.keyStatus(k); } catch (e) { /* 落到本地 */ }
    }
    if (k.revoked) return 'revoked';
    if (k.exp) {
      var d = daysLeft(ctx, k.exp);
      if (d < 0) return 'exp';
      if (d <= 30) return 'warn';
    }
    return 'ok';
  }

  function daysLeft(ctx, dateStr) {
    var api = ctx && ctx.api;
    if (api && typeof api.daysFromToday === 'function') {
      try { return api.daysFromToday(dateStr); } catch (e) { /* 落到本地 */ }
    }
    var t = new Date(dateStr + 'T00:00:00');
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.round((t - now) / 86400000);
  }

  function platLabelOf(ctx, k) {
    var api = ctx && ctx.api;
    if (api && typeof api.platLabel === 'function') {
      try { return api.platLabel(k); } catch (e) { /* 落到本地 */ }
    }
    if (k.platform === 'custom') return k.customName || '自定义平台';
    var dict = (ctx && ctx.platforms) || {};
    var p = dict[k.platform];
    return (p && p.name) || k.platform || '未知平台';
  }

  function shortNameOf(ctx, k) {
    var api = ctx && ctx.api;
    if (api && typeof api.shortName === 'function') {
      try { return api.shortName(k); } catch (e) { /* 落到本地 */ }
    }
    return k.name || '';
  }

  /* 「还没测过连通」：没有测试记录，或者有记录但没结论（ok 为 null）。
     这是一个事实标记，不参与状态分桶。 */
  function isUntested(k) {
    var t = k && k.test;
    if (!t) return true;
    if (t.ok === null) return true;
    return false;
  }

  function findKey(keys, id) {
    if (id == null) return null;
    for (var i = 0; i < keys.length; i++) {
      if (Number(keys[i].id) === Number(id)) return keys[i];
    }
    return null;
  }

  /* 从 index.html 的完整卡里原样搬一块出来（模型抽屉 / 记录配置去向的输入条）。
     这两块的实现在 index.html 的闭包里，布局层拿不到；
     与其自己复刻一份（复刻就会与真实行为分叉），不如把那张卡里的原物剪出来。
     按 div 深度配平，找到这一块的闭合位置。 */
  function extractBlock(html, cls) {
    if (!html) return '';
    var open = /<div\b([^>]*)>/g, m;
    while ((m = open.exec(html)) !== null) {
      var cm = /class="([^"]*)"/.exec(m[1]);
      if (!cm) continue;
      if (cm[1].split(/\s+/).indexOf(cls) < 0) continue;
      var depth = 1, t;
      var tag = /<\/?div\b[^>]*>/g;
      tag.lastIndex = open.lastIndex;
      while ((t = tag.exec(html)) !== null) {
        if (t[0].charAt(1) === '/') {
          depth--;
          if (depth === 0) return html.slice(m.index, t.index + t[0].length);
        } else {
          depth++;
        }
      }
      return '';
    }
    return '';
  }

  function insertBeforeEnd(html, frag) {
    if (!frag) return html;
    var i = html.lastIndexOf('</section>');
    if (i < 0) return html + frag;
    return html.slice(0, i) + frag + html.slice(i);
  }

  /* ================= 会话内状态 ================= */

  var state = {
    selectedId: null,   /* 选中的那把：本次会话内有效，不落 localStorage */
    query: '',          /* 左列表搜索词 */
    ctx: null           /* 最近一次渲染用的 ctx */
  };

  /* ================= 数据切片 ================= */

  /* 顶部筛选条（index.html 的 #filter-bar，data-filter + state.filter）：
     全部 / 有效 / 临期 / 过期停用。过期与停用并作一档，跟 index.html 同口径。
     「未测试」不是 keyStatus 的值，这里只作兜底：万一上面加了这一档，
     它装的是还没测过连通的那批，不跟「有效」抢同一批密钥。 */
  function filteredKeys(ctx) {
    var keys = (ctx && ctx.keys) || [];
    var f = (ctx && ctx.state && ctx.state.filter) || 'all';
    if (!f || f === 'all') return keys.slice();
    if (f === 'untested') {
      return keys.filter(function (k) { return isUntested(k); });
    }
    return keys.filter(function (k) {
      var st = statusOf(ctx, k);
      if (f === 'exp') return st === 'exp' || st === 'revoked';
      return st === f;
    });
  }

  /* 搜索：按密钥名或平台名过滤，纯前端 */
  function query() {
    return String(state.query || '').trim().toLowerCase();
  }

  function matchesQuery(ctx, k, q) {
    if (!q) return true;
    var name = String(k.name || '').toLowerCase();
    var plat = String(platLabelOf(ctx, k)).toLowerCase();
    var tail = String(shortNameOf(ctx, k)).toLowerCase();
    return name.indexOf(q) >= 0 || plat.indexOf(q) >= 0 || tail.indexOf(q) >= 0;
  }

  /* 平台分组：用共享层的 groups（它内部已经按 state.filter 过滤过），
     再按搜索词把组内过一遍，空组丢掉。 */
  function groupsOf(ctx) {
    var S = shared();
    var base;
    if (S && typeof S.groups === 'function') {
      try { base = S.groups(ctx) || []; } catch (e) { base = null; }
    }
    if (!base) base = fallbackGroups(ctx, filteredKeys(ctx));
    var q = query();
    var out = [];
    base.forEach(function (g) {
      var ks = q ? g.keys.filter(function (k) { return matchesQuery(ctx, k, q); }) : g.keys.slice();
      if (!ks.length) return;
      out.push({ label: g.label, color: g.color, keys: ks });
    });
    return out;
  }

  function fallbackGroups(ctx, keys) {
    var out = [], byLabel = {};
    keys.forEach(function (k) {
      var label = platLabelOf(ctx, k);
      if (!byLabel[label]) {
        byLabel[label] = { label: label, color: 'var(--ink-3)', keys: [] };
        out.push(byLabel[label]);
      }
      byLabel[label].keys.push(k);
    });
    return out;
  }

  function flatten(groups) {
    var out = [];
    groups.forEach(function (g) {
      g.keys.forEach(function (k) { out.push(k); });
    });
    return out;
  }

  function paneTitle(ctx) {
    var f = (ctx && ctx.state && ctx.state.filter) || 'all';
    if (f === 'ok') return '有效密钥';
    if (f === 'warn') return '临期密钥';
    if (f === 'exp') return '过期 / 停用密钥';
    if (f === 'untested') return '未测试密钥';
    return '全部密钥';
  }

  /* ================= 行 ================= */

  /* 行里只放能一眼扫过去的东西：平台色点、名称、状态、掩码末 4 位、端点条数、
     默认模型、余额或有效期其中一项。
     端点明细、模型参数、认证说明、配置去向都在右边详情里，行里不重复。 */
  function rowHtml(ctx, k) {
    var S = shared();
    var on = Number(k.id) === Number(state.selectedId);
    var eps = (k.endpoints || []).filter(function (e) { return e.url; }).length;
    var dot = S && typeof S.platDot === 'function' ? S.platDot(ctx, k) : '';
    var badge = S && typeof S.statusBadge === 'function' ? S.statusBadge(ctx, k) : '';
    var mask = S && typeof S.keyMask === 'function' ? S.keyMask(ctx, k) : '';
    var testChip = S && typeof S.testChip === 'function' ? S.testChip(ctx, k) : '';

    /* 余额或有效期只给一项：有到期日看到期日（能处置），没到期日再看余额。
       余额只有真金白银那档才算数，「待查询 / 暂不支持」是噪音，不占位。 */
    var tail = '';
    var b = k.balance || {};
    var hasBal = b.value != null && b.status !== 'pending' &&
      b.status !== 'unsupported' && b.status !== 'fail';
    if (k.exp) {
      tail = S && typeof S.expiryText === 'function' ? S.expiryText(ctx, k) : '';
    } else if (hasBal && S && typeof S.balanceText === 'function') {
      tail = S.balanceText(ctx, k);
    }

    return '<button type="button" class="keycard px-row' + (on ? ' px-row-on' : '') + '"' +
      ' data-id="' + k.id + '"' + (on ? ' aria-current="true"' : '') + '>' +
      '<span class="px-row-top">' + dot +
        '<b class="px-row-name">' + escOf(ctx, k.name) + '</b>' +
        badge +
        (isUntested(k)
          ? '<span class="px-untested" title="还没测过连通：在右边的详情里点「测试」">未测</span>'
          : '') +
        (testChip ? '<span class="px-row-chip">' + testChip + '</span>' : '') +
      '</span>' +
      '<span class="px-row-meta">' +
        '<span class="px-row-mask">' + escOf(ctx, mask) + '</span>' +
        '<span>' + eps + ' 端点</span>' +
        (k.model ? '<span class="px-row-model" title="默认模型">' + escOf(ctx, k.model) + '</span>' : '') +
        (tail ? '<span class="px-row-money">' + escOf(ctx, tail) + '</span>' : '') +
      '</span>' +
    '</button>';
  }

  /* ================= 组 ================= */

  /* 组头的状态计数：与顶部统计条同源（同一套 keyStatus、同一份数据），
     各组加起来就是统计条上的有效 / 临期 / 过期停用三格。 */
  function tallyHtml(ctx, g) {
    var c = { ok: 0, warn: 0, exp: 0 };
    (g.keys || []).forEach(function (k) {
      var st = statusOf(ctx, k);
      if (st === 'ok') c.ok++;
      else if (st === 'warn') c.warn++;
      else if (st === 'exp' || st === 'revoked') c.exp++;
    });
    var items = [];
    if (c.ok) items.push('<span class="px-tally-item ok">有效 ' + c.ok + '</span>');
    if (c.warn) items.push('<span class="px-tally-item warn">临期 ' + c.warn + '</span>');
    if (c.exp) items.push('<span class="px-tally-item exp">过期停用 ' + c.exp + '</span>');
    if (!items.length) return '';
    return '<span class="px-tally" title="这一组里的状态分布">' + items.join('') + '</span>';
  }

  function groupHtml(ctx, g) {
    var S = shared();
    var shut = S && typeof S.isCollapsed === 'function'
      ? S.isCollapsed(ctx, g.label)
      : !!(ctx.ui && ctx.ui.collapsedGroup && ctx.ui.collapsedGroup[g.label]);
    var head = (S && typeof S.groupHead === 'function')
      ? S.groupHead(ctx, g, tallyHtml(ctx, g))
      : fallbackGroupHead(ctx, g, tallyHtml(ctx, g));
    var body = shut ? '' :
      '<div class="px-rows">' + g.keys.map(function (k) { return rowHtml(ctx, k); }).join('') + '</div>';
    return '<section class="px-group" data-al-group="' + escOf(ctx, g.label) + '">' +
      head + body + '</section>';
  }

  function fallbackGroupHead(ctx, g, extraHtml) {
    return '<div class="lm-group-head">' +
      '<button type="button" class="group-title lm-group-title" data-act="toggle-group" data-label="' +
        escOf(ctx, g.label) + '" aria-expanded="true">' +
        '<span class="chev open" aria-hidden="true"></span>' +
        escOf(ctx, g.label) +
        '<span class="grp-n">' + ((g.keys && g.keys.length) || 0) + '</span>' +
      '</button>' +
      (extraHtml ? '<span class="lm-group-extra">' + extraHtml + '</span>' : '') +
    '</div>';
  }

  /* ================= 详情 ================= */

  /* 右详情：共享层的 detail（基本项 / 端点 / 模型参数 / 配置去向 四段）。
     模型抽屉与「记录配置去向」的输入条住在 index.html 的 renderCard() 里，
     从那张完整卡里原样剪出来接到详情面板尾部 —— 剪的是原件，不是复刻。 */
  function detailHtml(ctx, k) {
    var S = shared();
    var html;
    if (S && typeof S.detail === 'function') {
      try { html = S.detail(ctx, k); } catch (e) { html = null; }
    }
    if (!html) {
      var api = ctx && ctx.api;
      if (api && typeof api.renderCard === 'function') {
        try { html = api.renderCard(k); } catch (e) { html = null; }
      }
    }
    if (!html) html = '<section class="keycard lm-detail" data-id="' + k.id + '"></section>';

    var card = null;
    var api2 = ctx && ctx.api;
    if (api2 && typeof api2.renderCard === 'function') {
      try { card = api2.renderCard(k); } catch (e) { card = null; }
    }
    if (card) {
      html = insertBeforeEnd(html, extractBlock(card, 'tool-add-bar'));
      html = insertBeforeEnd(html, extractBlock(card, 'drawer'));
    }
    return html;
  }

  function emptyList(ctx, q) {
    var total = ((ctx && ctx.keys) || []).length;
    if (!total) {
      return '<div class="px-empty">' +
        '<div class="px-empty-t">这里还没有密钥</div>' +
        '<div class="px-empty-s">新增的密钥会出现在这里</div>' +
      '</div>';
    }
    if (q) {
      return '<div class="px-empty">' +
        '<div class="px-empty-t">没有匹配的密钥</div>' +
        '<div class="px-empty-s">换个词再搜，或清掉搜索框</div>' +
      '</div>';
    }
    return '<div class="px-empty">' +
      '<div class="px-empty-t">这一档里没有密钥</div>' +
      '<div class="px-empty-s">换个筛选条件看看</div>' +
    '</div>';
  }

  function emptyDetail() {
    return '<div class="px-empty">' +
      '<div class="px-empty-t">左边挑一把密钥</div>' +
      '<div class="px-empty-s">选中后这里显示它的完整档案</div>' +
    '</div>';
  }

  /* ================= 渲染 ================= */

  function render(ctx) {
    installStyle();
    state.ctx = ctx || { keys: [], platforms: {}, ui: {}, state: {}, api: {} };
    var groups = groupsOf(state.ctx);
    var visible = flatten(groups);
    /* 默认选第一条；原来选的那把被筛掉了就换成第一条还看得见的 */
    if (!findKey(visible, state.selectedId)) {
      state.selectedId = visible.length ? Number(visible[0].id) : null;
    }
    var sel = findKey(visible, state.selectedId);
    var q = query();

    return '<div class="px-main" data-al-main="1">' +
      '<section class="px-detail" data-al-detail="1" aria-label="密钥详情">' +
        (sel ? detailHtml(state.ctx, sel) : emptyDetail()) +
      '</section>' +
      '<aside class="px-listpane" aria-label="密钥列表">' +
        '<div class="px-pane-head">' +
          '<span class="px-pane-title">' + escOf(state.ctx, paneTitle(state.ctx)) + '</span>' +
          '<span class="px-count" data-al-count title="符合当前筛选与搜索的密钥数（收起的分组里的也算）">' + visible.length + '</span>' +
        '</div>' +
        '<div class="px-search">' +
          '<input class="px-search-input" type="search" data-al-search ' +
            'placeholder="搜索名称或平台" aria-label="按密钥名或平台名过滤" ' +
            'autocomplete="off" spellcheck="false" value="' + escOf(state.ctx, state.query) + '">' +
        '</div>' +
        '<div class="px-groups" data-al-list>' +
          (groups.length
            ? groups.map(function (g) { return groupHtml(state.ctx, g); }).join('')
            : emptyList(state.ctx, q)) +
        '</div>' +
      '</aside>' +
    '</div>';
  }

  /* ================= 布局内交互（搜索 / 选中） =================
     这两个不是业务动作：不带 data-act，index.html 的委托不会碰它们。
     业务按钮（test / edit / del / copy / reveal / toggle-models / config…）
     一律交给 index.html 的委托。 */

  function currentRoot() {
    if (typeof document === 'undefined') return null;
    return document.querySelector('[data-al-main]');
  }

  /* 只重画列表与详情两块，搜索框本身不重建：输入焦点与光标位置不丢。 */
  function refresh() {
    var ctx = state.ctx;
    if (!ctx) return;
    var root = currentRoot();
    if (!root) return;                       /* 已经切走或被整板重画了 */
    var pane = root.querySelector('[data-al-detail]');
    var list = root.querySelector('[data-al-list]');
    if (!pane || !list) return;

    var groups = groupsOf(ctx);
    var visible = flatten(groups);
    var sel = findKey(visible, state.selectedId);
    if (!sel) {
      sel = visible.length ? visible[0] : null;
      state.selectedId = sel ? Number(sel.id) : null;
    }
    pane.innerHTML = sel ? detailHtml(ctx, sel) : emptyDetail();
    list.innerHTML = groups.length
      ? groups.map(function (g) { return groupHtml(ctx, g); }).join('')
      : emptyList(ctx, query());
    var cnt = root.querySelector('[data-al-count]');
    if (cnt) cnt.textContent = String(visible.length);
  }

  function onClick(ev) {
    var t = ev.target;
    if (!t || typeof t.closest !== 'function') return;
    /* 业务动作不抢：让 index.html 的委托去处理 */
    if (t.closest('[data-act]')) return;
    var list = t.closest('[data-al-list]');
    if (!list) return;
    var item = t.closest('[data-id]');
    if (!item || !list.contains(item)) return;
    var raw = item.getAttribute('data-id');
    if (raw == null || raw === '') return;
    var id = Number(raw);
    if (!isFinite(id)) return;
    if (Number(id) === Number(state.selectedId)) return;
    state.selectedId = id;
    refresh();
  }

  function onInput(ev) {
    var t = ev.target;
    if (!t || typeof t.closest !== 'function') return;
    var input = t.closest('[data-al-search]');
    if (!input) return;
    state.query = input.value || '';
    refresh();
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
  }
  installStyle();

  /* ================= 注册 ================= */

  window.BoardLayouts = window.BoardLayouts || {};

  var main = function (ctx) { return render(ctx); };

  /* index.html 的 rerenderCard() 走 LayoutShared.cardHtml('main', …)：
     没有这一段，单卡重绘（显示明文 / 开抽屉 / 切认证）会把右侧详情面板
     换成一张完整卡，版式当场散架。这里给布局留一个自报形态的口子。 */
  main.cardHtml = function (ctx, k) { return detailHtml(ctx, k); };

  window.BoardLayouts.main = main;
})();
