/* ================= 用量/限流快照 → 观测历史 =================
   限额快照在密钥上只留最新一份（keys.usage 那一列），
   于是「5 小时窗口这一周怎么变的」画不出曲线 —— 观测历史表里得有点数。

   口径：**一个窗口 = 一行**。一次快照有 3 个窗口（5 小时 / 7 天 / 30 天）就写 3 行，
   每个窗口的 used 各画各的曲线；混成一行就分不清是哪个窗口在涨。
   行结构跟 test / balance 共用同一张表：
   · kind    = 'usage'
   · value   = 该窗口的 used —— 画曲线靠它，必须是能排序比较的数
   · detail  = JSON 字符串，带窗口名与上限（光有 used 画不出「用了 1200 / 上限 1500」）
   · status  = 快照的状态（ok / fail）
   · latency = 空（用量没有延迟可言，别编）

   两条规矩：
   ① used 为 null 的窗口不写行 —— 那是「这个窗口平台没报」，不是「用了 0」；
   ② 失败也写一行（value 为 null，原因写进 detail）——
      认证失败的原因要说清，而且曲线不能因为一次失败就断掉。

   纯计算模块：两个存储后端各写一遍这段逻辑的话，迟早一边改了另一边没改。 */
'use strict';

const USAGE_HISTORY_KIND = 'usage';

/* 存储层把 detail 截到 200 字（storage.js 的 HISTORY_DETAIL_MAX）。
   截断会把 JSON 截成半个，界面那边就 parse 不出来、曲线直接丢一条。
   所以这里自己保证长度：先丢可选字段（resetAt、kind），还超就把窗口名切短，
   name 与 limit 永远留着 —— 曲线靠 value，可读性靠 name/limit。 */
const DETAIL_MAX = 200;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function text(v) { return v == null ? '' : String(v); }

/* 永远吐得出合法 JSON：整串超长就逐级降级（丢 resetAt → 丢 kind → 切短 name） */
function fitDetail(obj) {
  const full = JSON.stringify(obj);
  if (full.length <= DETAIL_MAX) return full;

  const noReset = Object.assign({}, obj);
  delete noReset.resetAt;
  const a = JSON.stringify(noReset);
  if (a.length <= DETAIL_MAX) return a;

  const noKind = Object.assign({}, noReset);
  delete noKind.kind;
  const b = JSON.stringify(noKind);
  if (b.length <= DETAIL_MAX) return b;

  /* 窗口名太长：切短它（切的是字符串内部，JSON 仍然是合法的）。
     先丢 unit —— 它是「%」还是「次」的一两个字符，name/limit 才是可读性的底线。 */
  const noUnit = Object.assign({}, noKind);
  delete noUnit.unit;
  const c = JSON.stringify(noUnit);
  if (c.length <= DETAIL_MAX) return c;

  const name = text(noUnit.name);
  let cut = name.length;
  while (cut > 0) {
    const cand = JSON.stringify(Object.assign({}, noUnit, { name: name.slice(0, cut) }));
    if (cand.length <= DETAIL_MAX) return cand;
    cut = Math.floor(cut / 2);
  }
  return JSON.stringify(Object.assign({}, noUnit, { name: '' }));
}

/* 一次快照 → 若干条历史行。纯函数：同一份输入，两个后端必然给出同一批行。 */
function usageHistoryEntries(usage) {
  const u = (usage && typeof usage === 'object') ? usage : {};
  const status = u.status ? String(u.status) : 'pending';
  const kind = u.kind == null ? null : String(u.kind);
  const msg = u.msg == null ? '' : String(u.msg);

  /* 失败也记一行：value 为 null，原因写进 detail */
  if (status === 'fail') {
    return [{
      kind: USAGE_HISTORY_KIND,
      status: status,
      value: null,
      detail: fitDetail({ msg: msg, kind: kind })
    }];
  }

  const windows = Array.isArray(u.windows) ? u.windows : [];
  const out = [];
  windows.forEach(function (w) {
    const x = (w && typeof w === 'object') ? w : {};
    const used = num(x.used);
    if (used === null) return; /* 平台没报这个窗口 —— 不是「用了 0」，不写行 */
    out.push({
      kind: USAGE_HISTORY_KIND,
      status: status,
      value: used,
      detail: fitDetail({
        name: text(x.name),
        /* 单位要带：智谱的限额窗口给的是百分比（40.5%），不给单位就看不出是百分比还是次数 */
        unit: text(x.unit),
        limit: num(x.limit),
        resetAt: x.resetAt == null ? null : String(x.resetAt),
        kind: kind
      })
    });
  });
  return out;
}

module.exports = {
  USAGE_HISTORY_KIND: USAGE_HISTORY_KIND,
  usageHistoryEntries: usageHistoryEntries
};
