/* API-AegisLens · 布局共享层（layout-shared.js）
   四套布局（仪表盘 / 账本 / 主从 / 状态列）共用的内容渲染原子。
   另一层只管「怎么摆」，这一层管「摆什么」。

   两条硬规矩：
   1) 行为不重写。reveal 的取用与失败提示、测试中状态、删除二次确认、模型抽屉、
      配置去向抽屉，全在 index.html 的 renderCard() 里。ctx.api.renderCard 在就转调它，
      零行为偏差；ctx.api 缺位（index.html 的导出块没跑到）时退回本地等价实现，
      状态读法与文案口径照抄 index.html，不自创一套 —— 自创就会与真实行为分叉。
   2) 不绑事件。data-act 沿用 index.html 现有的名字（test / edit / del / copy / reveal /
      ep-test / ep-models / toggle-group / collapse-all / toggle-models / toggle-auth /
      toggle-assigned / config / rm-assigned …），事件委托在 index.html 里统一处理。
      本文件不写 onclick、不 addEventListener。

   卡片容器一律带 class="keycard" 与 data-id：
   委托靠 btn.closest('.keycard') 再 findKey(card.dataset.id) 找记录，缺了就点了没反应；
   单卡重绘 rerenderCard() 也是按 .keycard[data-id] 找节点。 */

(function () {
  'use strict';

  /* ================= 基础工具（抄 index.html，不自创） ================= */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* index.html 的 ST_LABEL：四态各有色，颜色走 .st.ok/.st.warn/.st.exp/.st.revoked。 */
  var ST_LABEL = { ok: '有效', warn: '临期', exp: '已过期', revoked: '已停用' };

  /* 模型参数来源。抄 index.html 的三张表：来源必须逐个显式列出，
     未识别值原样吐出来 —— 把「我不知道」渲染成「我有内置元数据」是撒谎。 */
  var SRC_LABEL = {
    api: '平台接口', meta: '元数据库', web: '联网检索',
    manual: '手动填写', builtin: '官方目录', unknown: '参数未取到'
  };
  var SRC_SPLIT_LABEL = {
    api: '接口', meta: '内置表', web: '联网', manual: '手动',
    builtin: '官方目录', unknown: '未取到'
  };
  var SRC_CLS = { api: ' api', web: ' web', builtin: ' builtin', unknown: ' unknown' };

  /* ctx.api 是 index.html 导出的内部原子包。取得到就用它（零偏差），
     取不到就用本地等价实现，绝不因为导出没到位就让整层瘫掉。 */
  function pick(ctx, name, fallback) {
    var A = ctx && ctx.api;
    if (A && typeof A[name] === 'function') {
      try { return A[name].bind(A); } catch (e) { /* 落到本地实现 */ }
    }
    return fallback;
  }

  function escOf(ctx, s) {
    var f = pick(ctx, 'esc', null);
    if (f) { try { return f(s); } catch (e) { /* 落到本地 */ } }
    return esc(s);
  }

  function ic(name, size) {
    var s = size || 14;
    return '<svg class="ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none"' +
      ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }
  function eyeIcon(revealed) { return ic(revealed ? 'eye-off' : 'eye'); }

  /* ================= 状态读法（与 index.html 同口径） ================= */

  function daysFromToday(dateStr) {
    var t = new Date(dateStr + 'T00:00:00');
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.round((t - now) / 86400000);
  }

  function keyStatusOf(ctx, k) {
    var f = pick(ctx, 'keyStatus', null);
    if (f) { try { return f(k); } catch (e) { /* 落到本地 */ } }
    if (k.revoked) return 'revoked';
    if (k.exp) {
      var d = daysFromToday(k.exp);
      if (d < 0) return 'exp';
      if (d <= 30) return 'warn';
    }
    return 'ok';
  }

  function fmtK(n) {
    if (n == null) return '未知';
    return n >= 1024 ? Math.round(n / 1024) + 'K' : String(n);
  }

  function maskKey(k) {
    if (!k || k.length <= 8) return k || '';
    return k.slice(0, 3) + '••••••••••••' + k.slice(-4);
  }

  /* 掩码文案统一出口（index.html 同款）：两头都没有就明写「无掩码」，
     绝不拿空串冒充一条看起来正常的记录。 */
  function keyMaskText(k) {
    if (k && k.keyMasked) return '••••••••' + k.keyMasked;
    if (k && typeof k.key === 'string' && k.key) return maskKey(k.key);
    return '无掩码';
  }

  function autoTailOf(v) {
    var s = String(v == null ? '' : v);
    return s.length >= 4 ? s.slice(-4) : s;
  }
  function isAutoNameOf(k) {
    var f = pick(null, 'isAutoName', null);
    if (f) { try { return f(k); } catch (e) { /* 落到本地 */ } }
    return !!k.name && k.name === autoTailOf(k.keyMasked);
  }

  function styleLabel(s) {
    if (s === 'anthropic') return 'Anthropic 兼容';
    if (s === 'openai') return 'OpenAI 兼容';
    return s || 'OpenAI 兼容';
  }
  function styleShort(s) {
    if (s === 'anthropic') return 'Anthropic';
    if (s === 'openai') return 'OpenAI';
    return s || 'OpenAI';
  }

  /* ================= 平台 ================= */

  function platformOf(ctx, k) {
    var ps = (ctx && ctx.platforms) || {};
    return ps[k.platform] || null;
  }

  function platLabel(ctx, k) {
    var f = pick(ctx, 'platLabel', null);
    if (f) { try { return f(k); } catch (e) { /* 落到本地 */ } }
    if (k.platform === 'custom') return k.customName || '自定义平台';
    var p = platformOf(ctx, k);
    return (p && p.name) || k.platform || '未知平台';
  }

  /* 平台颜色是运行时数据，但要塞进 style 属性：只放行长得像颜色的串，
     免得哪天平台名里带个分号就能往页面里塞样式。 */
  function safeColor(c) {
    var s = String(c == null ? '' : c).trim();
    if (!s) return 'var(--ink-3)';
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
    if (/^var\(--[A-Za-z0-9_-]+\)$/.test(s)) return s;
    if (/^(rgb|hsl)a?\(\s*[-0-9.,%\s/]+\)$/.test(s)) return s;
    if (/^[a-zA-Z]{3,20}$/.test(s)) return s;
    return 'var(--ink-3)';
  }

  function platColor(ctx, k) {
    var p = platformOf(ctx, k);
    return safeColor(p && p.color);
  }

  function currencyOf(ctx, k) {
    var p = platformOf(ctx, k);
    if (p && p.currency) return p.currency;
    if (k.balance && k.balance.currency) return k.balance.currency;
    return 'CNY';
  }

  function authNoteOf(ctx, k) {
    var p = platformOf(ctx, k);
    return k.authNote || (p && p.authNote) || '';
  }

  /* 库里名字不动，卡片头部左边已经有平台标签了，这里只留尾巴。 */
  function shortNameOf(ctx, k) {
    var prefix = platLabel(ctx, k) + '-';
    var n = String(k.name || '');
    return n.indexOf(prefix) === 0 && n.length > prefix.length ? n.slice(prefix.length) : n;
  }

  /* ================= 展示文本 ================= */

  /* 余额：暂不支持 / 待查询 / 查询失败 / ¥金额。 */
  function balanceTextOf(ctx, k) {
    var f = pick(ctx, 'balanceText', null);
    if (f) { try { return f(k); } catch (e) { /* 落到本地 */ } }
    var b = k.balance || {};
    if (b.status === 'pending') return '待查询';
    if (b.status === 'unsupported') return '暂不支持';
    if (b.status === 'fail') return '查询失败';
    if (b.value == null) return '待查询';
    return (currencyOf(ctx, k) === 'USD' ? '$' : '¥') + Number(b.value).toFixed(2);
  }

  /* 有效期：长期有效 / 到期倒计时 / 已过期。 */
  function expiryTextOf(ctx, k) {
    if (!k.exp) return '长期有效';
    var st = keyStatusOf(ctx, k);
    if (st === 'exp') return '已于 ' + k.exp + ' 过期';
    var d = daysFromToday(k.exp);
    if (d < 0) return '已于 ' + k.exp + ' 过期';
    if (d <= 30) return k.exp + ' 到期（剩 ' + d + ' 天）';
    return '有效期至 ' + k.exp;
  }

  /* 掩码 Key 的显示文本。 */
  function keyMaskOf(ctx, k) {
    var f = pick(ctx, 'keyMaskText', null);
    if (f) { try { return f(k); } catch (e) { /* 落到本地 */ } }
    return keyMaskText(k);
  }

  /* 状态徽章：四态各有色，颜色由 .st.ok/.st.warn/.st.exp/.st.revoked 走皮肤变量。 */
  function statusBadgeOf(ctx, k) {
    var st = keyStatusOf(ctx, k);
    var labels = (ctx && ctx.api && ctx.api.ST_LABEL) || ST_LABEL;
    var label = labels[st] || ST_LABEL[st] || st;
    return '<span class="st ' + st + '">' + escOf(ctx, label) + '</span>';
  }

  function platDotOf(ctx, k) {
    return '<span class="plat-dot" style="background:' + platColor(ctx, k) + '"></span>';
  }

  /* ================= reveal 状态 ================= */

  /* 明文只存在 index.html 的闭包里（revealTmp / revealNote），契约里的 ctx 没带出来。
     逐个可能的落点探一遍，探不到就退回掩码：宁可少显示，也不能编一句「取用中」出来。 */
  function revealState(ctx, k) {
    var sources = [];
    if (ctx) {
      if (ctx.state) sources.push(ctx.state);
      if (ctx.ui) sources.push(ctx.ui);
      if (ctx.api) sources.push(ctx.api);
      sources.push(ctx);
    }
    var tmp = null, note = null;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      /* 两个容器各自取，谁先给谁先用：不能因为后一个没有就把前面取到的覆盖掉。 */
      if (tmp === null && s.revealTmp) tmp = s.revealTmp;
      if (note === null && s.revealNote) note = s.revealNote;
      if (tmp !== null && note !== null) break;
    }
    var n = (note && note[k.id]) || null;
    return {
      text: (tmp && tmp[k.id]) || '',
      pending: !!(n && n.pending),
      err: (n && n.err) || ''
    };
  }

  /* ================= 测试结果 ================= */

  /* 让徽章说清是哪条端点通了；该端点事后被改过就标注失效。 */
  function epSuffixOf(ctx, k) {
    var t = k.test;
    if (!t || t.epIndex == null) return '';
    var live = (k.endpoints || []).some(function (e) { return e.url && e.url === t.epUrl; });
    return ' · #' + (t.epIndex + 1) + (t.epStyle ? ' ' + styleShort(t.epStyle) : '') + (live ? '' : ' ⚠地址已变更');
  }

  function testChipOf(ctx, k) {
    var t = k.test;
    if (!t) return '';
    var pass = t.status ? (t.status === 'pass') : !!t.ok;
    var suffix = epSuffixOf(ctx, k);
    if (pass) {
      var lat = (t.latency != null) ? (t.latency + 'ms') : '';
      return '<span class="test-chip pass" title="' + escOf(ctx, t.msg || t.detail || '') + '">连通' +
        (lat ? ' · ' + escOf(ctx, lat) : '') + escOf(ctx, suffix) + '</span>';
    }
    var why = t.code || t.error || t.msg || '失败';
    return '<span class="test-chip fail" title="' + escOf(ctx, t.msg || t.error || t.detail || '') + '">不通 · ' +
      escOf(ctx, why) + escOf(ctx, suffix) + '</span>';
  }

  /* ================= 模型来源（抄 index.html 的 fieldSrcs / srcChips） ================= */

  function fieldSrcs(m) {
    if (!m) return { ctxSrc: null, outSrc: null };
    if (m.src === 'manual' && m.ctxSrc !== 'manual' && m.outSrc !== 'manual') {
      return { ctxSrc: null, outSrc: null };
    }
    if (m.ctxSrc || m.outSrc) return { ctxSrc: m.ctxSrc || null, outSrc: m.outSrc || null };
    var legacy = (m.src && m.src !== 'unknown') ? m.src : null;
    return { ctxSrc: m.ctx != null ? legacy : null, outSrc: m.out != null ? legacy : null };
  }

  function srcChipsOf(m) {
    var fs = fieldSrcs(m);
    if (fs.ctxSrc && fs.outSrc && fs.ctxSrc !== fs.outSrc) {
      function one(field, src) {
        var label = Object.prototype.hasOwnProperty.call(SRC_SPLIT_LABEL, src)
          ? SRC_SPLIT_LABEL[src] : String(src);
        var cls = (Object.prototype.hasOwnProperty.call(SRC_CLS, src) && SRC_CLS[src]) || '';
        return '<span class="m-tag' + cls + ' split">' + field + ' · ' + esc(label) + '</span>';
      }
      return one('上下文', fs.ctxSrc) + one('输出', fs.outSrc);
    }
    var hasSrc = Object.prototype.hasOwnProperty.call(SRC_LABEL, m.src);
    var srcLabel = hasSrc ? SRC_LABEL[m.src]
      : '未识别来源 ' + (m.src == null || m.src === '' ? '（空）' : m.src);
    var srcCls = (Object.prototype.hasOwnProperty.call(SRC_CLS, m.src) && SRC_CLS[m.src]) || '';
    return '<span class="m-tag' + srcCls + '">' + srcLabel + '</span>';
  }

  function modelIdOf(m) { return m.id || m.name || ''; }

  /* ================= 共用片段 ================= */

  /* Key 那一条：掩码 / 明文 / 取用中 / 取不到，外加「显示」与「复制」。 */
  function keyParamOf(ctx, k) {
    var rv = revealState(ctx, k);
    var shown = rv.pending ? '取用中…' : (rv.text || keyMaskOf(ctx, k));
    return '<span class="param key' + (rv.text ? ' is-revealed' : '') + '" data-key-copy="' + k.id + '">' +
      '<span class="lbl2">Key</span>' +
      '<span class="val">' + escOf(ctx, shown) + '</span>' +
      (rv.err ? '<span class="val" style="color:var(--warn)">取不到明文 · ' + escOf(ctx, rv.err) + '</span>' : '') +
      '<span class="ep-acts">' +
        '<button class="eye" data-act="reveal"' + (rv.pending ? ' disabled' : '') + ' aria-label="' +
          (rv.text ? '隐藏明文' : '显示明文') + '" title="' + (rv.text ? '隐藏' : '显示明文') + '">' + eyeIcon(rv.text) + '</button>' +
        '<button class="copy-btn" data-act="copy"' + (rv.pending ? ' disabled' : '') +
          ' title="复制完整 Key（这一刻才向保险库取用明文，30 秒后收回掩码）">复制</button>' +
      '</span>' +
    '</span>';
  }

  /* 端点：全部列出，带协议风格与「复制 / 测这条 / 拉模型」。 */
  function endpointParamsOf(ctx, k) {
    return (k.endpoints || []).map(function (ep, i) {
      if (!ep.url) return '';
      return '<span class="param url" data-copy="' + escOf(ctx, ep.url) + '" title="' + escOf(ctx, styleLabel(ep.style)) + ' 端点，点击复制按钮取地址">' +
        '<span class="lbl2">端点 ' + (i + 1) + '</span>' +
        '<span class="val">' + escOf(ctx, ep.url) + '</span>' +
        '<span class="ep-style-tag" title="' + escOf(ctx, styleLabel(ep.style)) + '">' + escOf(ctx, styleShort(ep.style)) + '</span>' +
        '<span class="ep-acts">' +
          '<button class="copy-btn" data-act="copy" title="复制 ' + escOf(ctx, ep.url) + '">复制</button>' +
          '<button class="btn ghost small" data-act="ep-test" data-idx="' + i + '" title="只测这一条端点，不影响其他端点">测这条</button>' +
          '<button class="btn ghost small" data-act="ep-models" data-idx="' + i + '" title="从这一条端点拉取模型清单">拉模型</button>' +
        '</span>' +
      '</span>';
    }).join('');
  }

  /* 模型参数：模型 ID + 上下文 / 最大输出 + 来源标记（api/web/builtin/manual…）。 */
  function modelParamsOf(ctx, k) {
    var models = k.models || [];
    if (!models.length) {
      return '<div class="lm-empty">' + (k.modelsFetched ? '平台未返回任何模型' : '还没拉过模型') + '</div>';
    }
    return models.map(function (m) {
      var mid = modelIdOf(m);
      var isDef = !!mid && mid === k.model;
      return '<div class="lm-model' + (isDef ? ' default' : '') + '">' +
        '<span class="lm-model-id">' + escOf(ctx, mid) + '</span>' +
        '<span class="mspec">上下文 <b>' + escOf(ctx, fmtK(m.ctx)) + '</b></span>' +
        '<span class="mspec">最大输出 <b>' + escOf(ctx, fmtK(m.out)) + '</b></span>' +
        srcChipsOf(m) +
        (m.reasoning === true ? '<span class="m-cap">支持推理</span>'
          : (m.reasoning === false ? '<span class="m-cap off">不支持推理</span>' : '')) +
        (m.note ? '<span class="lm-note">' + escOf(ctx, m.note) + '</span>' : '') +
        (isDef ? '<span class="m-default">当前默认</span>' : '') +
      '</div>';
    }).join('');
  }

  /* 配置去向：工具 + 哪台电脑。 */
  function assignedChipsOf(ctx, k) {
    var assigned = k.assigned || [];
    return '<span class="kc-assigned">' +
      (assigned.length ? '<span class="meta">已配置到</span>' : '') +
      assigned.map(function (a) {
        var label = a.tool + (a.host ? ' · ' + a.host : '');
        return '<span class="tool-chip">' + escOf(ctx, label) +
          '<button class="rm" data-act="rm-assigned" data-tool="' + escOf(ctx, a.tool) + '" data-host="' +
          escOf(ctx, a.host) + '" title="移除「' + escOf(ctx, label) + '」" aria-label="移除 ' + escOf(ctx, label) + '">' + ic('x') + '</button></span>';
      }).join('') +
      '<button class="btn ghost small" data-act="toggle-assigned" title="登记这个密钥被配到了哪个工具、哪台电脑">' +
        (assigned.length ? '+ 添加去向' : '+ 记录配置去向') +
      '</button>' +
    '</span>';
  }

  function testBtnOf(ctx, k) {
    var testing = !!(ctx && ctx.ui && ctx.ui.testing && ctx.ui.testing[k.id]);
    if (testing) return '<button class="btn ghost small" disabled><span class="spin"></span> 测试中</button>';
    return '<button class="btn ghost small" data-act="test" title="调用平台模型列表接口验证密钥可用性">' +
      (k.test ? '重新测试' : '测试') + '</button>';
  }

  function modelsBtnOf(ctx, k) {
    var n = (k.models || []).length;
    return '<button class="btn small" data-act="toggle-models">' +
      escOf(ctx, k.modelsFetched ? ('模型清单 ' + n) : '模型清单') + '</button>';
  }

  function authChipOf(ctx, k) {
    var note = authNoteOf(ctx, k);
    if (!note) return '';
    return '<button class="auth-chip" data-act="toggle-auth" title="该密钥带特殊认证说明，点击展开查看">' +
      ic('triangle-alert') + ' 特殊认证</button>';
  }

  /* 变体里特殊认证说明一直显示：展开要靠 rerenderCard 单卡重绘，
     而重绘会把整行/整张紧凑卡换成完整卡（见文件头说明），展开动作不牢靠。 */
  function authNoteLineOf(ctx, k) {
    var note = authNoteOf(ctx, k);
    if (!note) return '';
    return '<span class="lm-auth">' + ic('triangle-alert') + ' ' + escOf(ctx, note) + '</span>';
  }

  function isCollapsed(ctx, label) {
    var u = (ctx && ctx.ui) || null;
    return !!(u && u.collapsedGroup && u.collapsedGroup[label]);
  }

  /* 看板筛选：与 index.html 的 renderBoard 同口径（exp 把「过期」与「停用」并作一档）。 */
  function filterKeys(ctx) {
    var all = (ctx && ctx.keys) || [];
    var f = (ctx && ctx.state && ctx.state.filter) || 'all';
    if (f === 'all') return all.slice();
    return all.filter(function (k) {
      var st = keyStatusOf(ctx, k);
      if (f === 'exp') return st === 'exp' || st === 'revoked';
      return st === f;
    });
  }

  /* ================= 完整卡（优先转调 index.html） ================= */

  /* ctx.api.renderCard 在就转调它：抽屉、删除二次确认、模型清单全都在那里面，
     自己复刻一份就会与真实行为分叉。ctx.api 缺位时的本地等价实现，
     结构与 class 沿用 index.html 的那套，样式自动跟着皮肤走。 */
  function localCard(ctx, k) {
    var st = keyStatusOf(ctx, k);
    var authNote = authNoteOf(ctx, k);
    var authOpen = !!(ctx && ctx.ui && ctx.ui.authOpen && ctx.ui.authOpen[k.id]);
    return '<article class="keycard" data-id="' + k.id + '">' +
      '<div class="kc-main">' +
        '<div class="kc-l1">' +
          '<span class="plat">' + escOf(ctx, shortNameOf(ctx, k)) + '</span>' +
          (isAutoNameOf(k) ? '<span class="auto-tag" title="名称取自密钥末 4 位，建议改成自己认得出的名字">自动命名</span>' : '') +
          statusBadgeOf(ctx, k) +
          testChipOf(ctx, k) +
          authChipOf(ctx, k) +
          '<span class="kc-actions">' +
            testBtnOf(ctx, k) +
            '<button class="btn ghost small" data-act="edit">编辑</button>' +
            '<button class="btn ghost small danger" data-act="del">删除</button>' +
          '</span>' +
        '</div>' +
        '<div class="kc-meta">' +
          '<span class="m-item">余额 <b>' + escOf(ctx, balanceTextOf(ctx, k)) + '</b></span>' +
          (k.exp ? '<span class="m-item st-' + st + '">有效期至 <b>' + escOf(ctx, k.exp) + '</b></span>'
                 : '<span class="m-item">长期有效</span>') +
          (k.reg ? '<span class="m-item">注册于 <b>' + escOf(ctx, k.reg) + '</b></span>' : '') +
        '</div>' +
        '<div class="params">' +
          keyParamOf(ctx, k) +
          endpointParamsOf(ctx, k) +
          (k.model ? '<span class="param" data-copy="' + escOf(ctx, k.model) + '"><span class="lbl2">默认模型</span>' +
            '<span class="val">' + escOf(ctx, k.model) + '</span><button class="copy-btn" data-act="copy">复制</button></span>' : '') +
        '</div>' +
        (authNote && authOpen ? '<div class="auth-note-bar">' + ic('triangle-alert') + ' ' + escOf(ctx, authNote) + '</div>' : '') +
        '<div class="kc-foot">' +
          assignedChipsOf(ctx, k) +
          '<span class="kc-more">' +
            modelsBtnOf(ctx, k) +
            '<button class="btn primary small" data-act="config">生成配置</button>' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="drawer"></div>' +
    '</article>';
  }

  /* ================= 表格行（账本） ================= */

  function rowOf(ctx, k) {
    var models = k.models || [];
    var styles = [];
    (k.endpoints || []).forEach(function (ep) {
      if (ep.url && styles.indexOf(styleShort(ep.style)) < 0) styles.push(styleShort(ep.style));
    });
    return '<tr class="keycard lm-row" data-id="' + k.id + '">' +
      '<td class="lm-c-key">' +
        platDotOf(ctx, k) + '<b>' + escOf(ctx, k.name) + '</b>' +
        (isAutoNameOf(k) ? '<span class="auto-tag" title="名称取自密钥末 4 位，建议改成自己认得出的名字">自动命名</span>' : '') +
      '</td>' +
      '<td class="lm-c-plat">' + escOf(ctx, platLabel(ctx, k)) + '</td>' +
      '<td class="lm-c-st">' + statusBadgeOf(ctx, k) + testChipOf(ctx, k) + authChipOf(ctx, k) + authNoteLineOf(ctx, k) + '</td>' +
      '<td class="lm-c-keyparam">' + keyParamOf(ctx, k) + '</td>' +
      '<td class="lm-c-eps"><div class="lm-eps">' + endpointParamsOf(ctx, k) + '</div></td>' +
      '<td class="lm-c-model">' +
        (k.model ? '<div class="lm-model-id">' + escOf(ctx, k.model) + '</div>' : '<div class="lm-model-id">未设置</div>') +
        '<div class="lm-sub">' + models.length + ' 个模型' + (styles.length ? ' · ' + escOf(ctx, styles.join(' / ')) : '') + '</div>' +
        '<div class="lm-models">' + modelParamsOf(ctx, k) + '</div>' +
      '</td>' +
      '<td class="lm-c-bal">' + escOf(ctx, balanceTextOf(ctx, k)) + '</td>' +
      '<td class="lm-c-exp">' + escOf(ctx, expiryTextOf(ctx, k)) +
        (k.reg ? '<div class="lm-sub">注册于 ' + escOf(ctx, k.reg) + '</div>' : '') +
      '</td>' +
      '<td class="lm-c-assigned">' + assignedChipsOf(ctx, k) + '</td>' +
      '<td class="lm-c-acts">' +
        '<div class="lm-acts">' +
          testBtnOf(ctx, k) +
          '<button class="btn ghost small" data-act="edit">编辑</button>' +
          '<button class="btn ghost small danger" data-act="del">删除</button>' +
        '</div>' +
        '<div class="lm-acts">' + modelsBtnOf(ctx, k) +
          '<button class="btn primary small" data-act="config">生成配置</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }

  /* ================= 紧凑卡（状态列） ================= */

  function compactOf(ctx, k) {
    var models = k.models || [];
    return '<article class="keycard lm-compact" data-id="' + k.id + '">' +
      '<div class="kc-l1 lm-compact-head">' +
        platDotOf(ctx, k) +
        '<span class="lm-plat-name">' + escOf(ctx, platLabel(ctx, k)) + '</span>' +
        '<b class="lm-name">' + escOf(ctx, k.name) + '</b>' +
        statusBadgeOf(ctx, k) +
        testChipOf(ctx, k) +
        authChipOf(ctx, k) +
      '</div>' +
      authNoteLineOf(ctx, k) +
      '<div class="params lm-compact-params">' +
        keyParamOf(ctx, k) +
        '<span class="param"><span class="lbl2">余额</span><span class="val">' + escOf(ctx, balanceTextOf(ctx, k)) + '</span></span>' +
        '<span class="param"><span class="lbl2">有效期</span><span class="val">' + escOf(ctx, expiryTextOf(ctx, k)) + '</span></span>' +
        (k.reg ? '<span class="param"><span class="lbl2">注册时间</span><span class="val">' + escOf(ctx, k.reg) + '</span></span>' : '') +
        '<span class="param"><span class="lbl2">默认模型</span><span class="val">' + escOf(ctx, k.model || '未设置') + '</span></span>' +
        '<span class="param"><span class="lbl2">模型</span><span class="val">' + models.length + ' 个</span></span>' +
      '</div>' +
      '<div class="lm-eps">' + endpointParamsOf(ctx, k) + '</div>' +
      '<div class="lm-models">' + modelParamsOf(ctx, k) + '</div>' +
      '<div class="lm-assigned">' + assignedChipsOf(ctx, k) + '</div>' +
      '<div class="lm-acts">' +
        testBtnOf(ctx, k) +
        '<button class="btn ghost small" data-act="edit">编辑</button>' +
        '<button class="btn ghost small danger" data-act="del">删除</button>' +
        modelsBtnOf(ctx, k) +
        '<button class="btn primary small" data-act="config">生成配置</button>' +
      '</div>' +
    '</article>';
  }

  /* ================= 列表项（主从） ================= */

  /* 列表项是 <button>：里面不能再套按钮（非法嵌套），
     所以这里只放看得见的字，不放动作；动作在右侧详情面板里。 */
  function listItemOf(ctx, k) {
    var models = k.models || [];
    var eps = (k.endpoints || []).filter(function (ep) { return ep.url; });
    var assigned = k.assigned || [];
    return '<button type="button" class="keycard lm-listitem" data-id="' + k.id + '">' +
      '<span class="lm-li-top">' +
        platDotOf(ctx, k) +
        '<b class="lm-name">' + escOf(ctx, k.name) + '</b>' +
        statusBadgeOf(ctx, k) +
      '</span>' +
      '<span class="lm-li-sub">' + escOf(ctx, platLabel(ctx, k)) + '</span>' +
      '<span class="lm-li-line">' + escOf(ctx, balanceTextOf(ctx, k)) + ' · ' + escOf(ctx, expiryTextOf(ctx, k)) + '</span>' +
      '<span class="lm-li-line lm-mono">' + escOf(ctx, keyMaskOf(ctx, k)) + '</span>' +
      '<span class="lm-li-line lm-dim">' +
        eps.length + ' 条端点' + (models.length ? ' · ' + models.length + ' 个模型' : '') +
        (assigned.length ? ' · 已配置 ' + assigned.length + ' 处' : '') +
      '</span>' +
      (testChipOf(ctx, k) ? '<span class="lm-li-line">' + testChipOf(ctx, k) + '</span>' : '') +
    '</button>';
  }

  /* 限额快照的两个原子：值与说明都从 ctx.api（AegisUI）取。
     共享层的规矩是「行为不重写」—— 自己复刻一份就会与真实行为分叉；
     ctx.api 缺位时（index.html 的导出块没跑到）退回空串，不显示这格。 */
  /* 余额的「这是什么时候的数」：同样从 ctx.api（AegisUI）取，不复刻。 */
  function balanceTitleOf(ctx, k) {
    var api = ctx && ctx.api;
    if (api && typeof api.balanceTitle === 'function') {
      try { return String(api.balanceTitle(k) || ''); } catch (e) { return ''; }
    }
    return '';
  }
  function usageTextOf(ctx, k) {
    var api = ctx && ctx.api;
    if (api && typeof api.usageText === 'function') {
      try { return String(api.usageText(k) || ''); } catch (e) { return ''; }
    }
    return '';
  }
  function usageTitleOf(ctx, k) {
    var api = ctx && ctx.api;
    if (api && typeof api.usageTitle === 'function') {
      try { return String(api.usageTitle(k) || ''); } catch (e) { return ''; }
    }
    return '';
  }

  /* ================= 详情面板（主从） ================= */

  /* 四段：基本项 / 端点 / 模型参数 / 配置去向。 */
  function detailOf(ctx, k) {
    var models = k.models || [];
    var eps = (k.endpoints || []).filter(function (ep) { return ep.url; });
    var styles = [];
    eps.forEach(function (ep) {
      if (styles.indexOf(styleShort(ep.style)) < 0) styles.push(styleShort(ep.style));
    });
    var assigned = k.assigned || [];
    return '<section class="keycard lm-detail" data-id="' + k.id + '">' +
      '<div class="lm-detail-head">' +
        platDotOf(ctx, k) +
        '<div class="lm-detail-title">' +
          '<h3>' + escOf(ctx, k.name) + '</h3>' +
          '<div class="lm-sub">' + escOf(ctx, platLabel(ctx, k)) +
            (isAutoNameOf(k) ? ' · 自动命名' : '') + '</div>' +
        '</div>' +
        statusBadgeOf(ctx, k) +
        testChipOf(ctx, k) +
        authChipOf(ctx, k) +
        '<span class="lm-acts">' +
          testBtnOf(ctx, k) +
          /* 业务动作只出 data-act，事件委托在 index.html 里统一处理（本层不绑事件） */
          '<button class="btn ghost small" data-act="key-usage" title="查这个平台的限额快照（用量/限流窗口）：账户级数据，与余额不是一回事">查限额</button>' +
          '<button class="btn ghost small" data-act="edit">编辑</button>' +
          '<button class="btn ghost small danger" data-act="del">删除</button>' +
        '</span>' +
      '</div>' +

      '<div class="lm-sec">基本项</div>' +
      '<div class="lm-kv-grid">' +
        '<div class="lm-kv"><span class="lbl2">平台</span><span>' + escOf(ctx, platLabel(ctx, k)) + '</span></div>' +
        '<div class="lm-kv"><span class="lbl2">状态</span><span>' + statusBadgeOf(ctx, k) + '</span></div>' +
        '<div class="lm-kv"><span class="lbl2">余额</span><span title="' + escOf(ctx, balanceTitleOf(ctx, k)) + '">' + escOf(ctx, balanceTextOf(ctx, k)) + '</span></div>' +
        '<div class="lm-kv"><span class="lbl2">限额快照</span><span title="' + escOf(ctx, usageTitleOf(ctx, k)) + '">' + escOf(ctx, usageTextOf(ctx, k)) + '</span></div>' +
        '<div class="lm-kv"><span class="lbl2">有效期</span><span>' + escOf(ctx, expiryTextOf(ctx, k)) + '</span></div>' +
        '<div class="lm-kv"><span class="lbl2">注册时间</span><span>' + escOf(ctx, k.reg || '未记录') + '</span></div>' +
        '<div class="lm-kv"><span class="lbl2">协议风格</span><span>' + escOf(ctx, styles.length ? styles.join(' / ') : '未设置') + '</span></div>' +
        '<div class="lm-kv"><span class="lbl2">默认模型</span><span class="lm-mono">' + escOf(ctx, k.model || '未设置') + '</span></div>' +
        /* 这一格不另起一个「Key」标签：keyParamOf 自己带 lbl2，
           两边都写就会在详情面板里连出两个「Key Key」。 */
        '<div class="lm-kv lm-kv-wide">' + keyParamOf(ctx, k) + '</div>' +
      '</div>' +
      authNoteLineOf(ctx, k) +

      '<div class="lm-sec">端点 <span class="lm-sub">' + eps.length + ' 条</span></div>' +
      '<div class="lm-eps">' + (eps.length ? endpointParamsOf(ctx, k) : '<div class="lm-empty">没设置端点</div>') + '</div>' +

      '<div class="lm-sec">模型参数 <span class="lm-sub">' + models.length + ' 个</span></div>' +
      '<div class="lm-models">' + modelParamsOf(ctx, k) + '</div>' +

      '<div class="lm-sec">配置去向 <span class="lm-sub">' + assigned.length + ' 处</span></div>' +
      '<div class="lm-assigned">' + assignedChipsOf(ctx, k) + '</div>' +

      '<div class="lm-detail-foot">' +
        modelsBtnOf(ctx, k) +
        '<button class="btn primary small" data-act="config">生成配置</button>' +
      '</div>' +
    '</section>';
  }

  /* ================= 分组标题 ================= */

  /* 折叠开关沿用现有机制：data-act="toggle-group" + data-label="<平台名>"，
     折叠状态在 ctx.ui.collapsedGroup[label]，持久化由 index.html 负责。 */
  function groupHeadOf(ctx, g, extraHtml) {
    var shut = isCollapsed(ctx, g.label);
    return '<div class="lm-group-head">' +
      '<button type="button" class="group-title lm-group-title" data-act="toggle-group" data-label="' +
        escOf(ctx, g.label) + '" aria-expanded="' + (shut ? 'false' : 'true') + '">' +
        '<span class="chev' + (shut ? '' : ' open') + '" aria-hidden="true"></span>' +
        platDotOf(ctx, g) +
        escOf(ctx, g.label) +
        '<span class="grp-n">' + (g.keys ? g.keys.length : 0) + '</span>' +
      '</button>' +
      (extraHtml ? '<span class="lm-group-extra">' + extraHtml + '</span>' : '') +
    '</div>';
  }

  /* ================= 对外接口 ================= */

  var LayoutShared = {

    /* 按平台分组，顺序按首次出现；每组 {label, color, keys:[k,...]} */
    groups: function (ctx) {
      var keys = filterKeys(ctx);
      var out = [], byLabel = {};
      keys.forEach(function (k) {
        var label = platLabel(ctx, k);
        if (!byLabel[label]) {
          byLabel[label] = { label: label, color: platColor(ctx, k), keys: [] };
          out.push(byLabel[label]);
        }
        byLabel[label].keys.push(k);
      });
      return out;
    },

    /* 完整卡片：直接转调 index.html 的 renderCard，零行为偏差 */
    fullCard: function (ctx, k) {
      var api = ctx && ctx.api;
      if (api && typeof api.renderCard === 'function') {
        try { return api.renderCard(k); } catch (e) { /* 落到本地等价实现 */ }
      }
      return localCard(ctx, k);
    },

    /* 表格行（一行一把） */
    row: function (ctx, k) { return rowOf(ctx, k); },

    /* 紧凑卡（状态列用） */
    compact: function (ctx, k) { return compactOf(ctx, k); },

    /* 列表项（主从用） */
    listItem: function (ctx, k) { return listItemOf(ctx, k); },

    /* 详情面板（主从用）：基本项 / 端点 / 模型参数 / 配置去向 四段 */
    detail: function (ctx, k) { return detailOf(ctx, k); },

    /* 分组标题行 */
    groupHead: function (ctx, g, extraHtml) { return groupHeadOf(ctx, g, extraHtml); },

    /* 小原子 */
    statusBadge: function (ctx, k) { return statusBadgeOf(ctx, k); },
    balanceText: function (ctx, k) { return balanceTextOf(ctx, k); },
    expiryText: function (ctx, k) { return expiryTextOf(ctx, k); },
    platDot: function (ctx, k) { return platDotOf(ctx, k); },
    keyMask: function (ctx, k) { return keyMaskOf(ctx, k); },

    /* ---- 顺手给布局层的零散工具（可选，不承诺稳定） ---- */

    /* 按布局选卡片变体：给 index.html 的 rerenderCard 用。
       接线方式（index.html 侧改动，不在本层范围内，改的是 rerenderCard 那一行）：
         var html = renderCard(k);
         if (window.LayoutShared) {
           html = window.LayoutShared.cardHtml(state.layout, {
             keys: state.keys, platforms: state.platforms, ui: ui, state: state, api: window.AegisUI
           }, k) || html;
         }
       没有这行接线时，reveal / 切换认证 / 开关模型抽屉会触发 rerenderCard，
       把表格行或紧凑卡换成整张完整卡（<tr> 变 <article>，表格会散）。 */
    cardHtml: function (layoutId, ctx, k) {
      if (layoutId === 'b') return rowOf(ctx, k);
      if (layoutId === 'c') return detailOf(ctx, k);
      if (layoutId === 'd') return compactOf(ctx, k);
      /* 布局自己报了形态就用它的：主视图的详情面板由 layout-main.js 决定，
         不然单卡重绘（显示明文 / 开模型抽屉 / 切认证）会把详情面板换成一张完整卡。 */
      var L = (typeof window !== 'undefined' && window.BoardLayouts) ? window.BoardLayouts[layoutId] : null;
      if (L && typeof L.cardHtml === 'function') {
        try { return L.cardHtml(ctx, k); } catch (e) { /* 落到本地等价实现 */ }
      }
      return localCard(ctx, k);
    },

    filterKeys: filterKeys,
    isCollapsed: isCollapsed,
    keyStatus: keyStatusOf,
    platLabel: platLabel,
    shortName: shortNameOf,
    styleLabel: styleLabel,
    styleShort: styleShort,
    authNoteOf: authNoteOf,
    esc: esc,
    testChip: testChipOf,
    keyParam: keyParamOf,
    endpointParams: endpointParamsOf,
    modelParams: modelParamsOf,
    assignedChips: assignedChipsOf,
    modelsBtn: modelsBtnOf
  };

  window.LayoutShared = LayoutShared;
})();
