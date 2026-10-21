/* 余额与「用量/限流窗口」两类厂商接口的目录与解析。
   两类口径是分开的，不能混：
   · 余额（钱）是 **Key 级** 的 —— 同一把 key 查到的钱属于这把 key；
   · 用量/限流窗口（5 小时窗口还剩几次、30 天配额还剩多少）是 **账户级** 的 ——
     同一平台的多个 key 查出来是同一个账户的数据。
   所以这里只出「怎么查、怎么解析」，落库由 storage.js 分两套字段存。

   ★ 这批接口的共同坑：**平台把错误裹在 HTTP 200 里**。
     智谱是 body.code（401）+ success:false，MiniMax 是 body.base_resp.status_code（1004），
     HTTP 状态码都是 200。旧实现只管找金额，找不到就一律报
     「平台返回了余额数据，但未能解析出金额」—— 认证失败时这句话是误导：
     用户会以为平台返回了正常数据、只是格式变了。
     所以下面分两层：**先判平台错误码（认证类说清「密钥无效/没权限」），
     判不出错误才轮到解析（这时才说「没解析出金额/窗口」）。 */

'use strict';

function fail(httpStatus, message, code) {
  const e = new Error(message);
  e.httpStatus = httpStatus;
  e.code = code;
  return e;
}

function hostOf(u) {
  try { return new URL(String(u)).hostname; } catch (e) { return null; }
}

function num(v) {
  if (v == null || v === '' || v === true || v === false) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseFailBalance() {
  return fail(502, '平台返回了余额数据，但未能解析出金额', 'PARSE');
}

function parseFailUsage() {
  return fail(502, '平台返回了用量数据，但未能解析出窗口', 'PARSE');
}

/* ================= 平台错误码 =================
   认证类与其它错误码分开说：认证类说清「密钥无效/没权限」，
   其它错误码原样转达（限流、欠费、参数错各有各的处置办法）。
   认证类的判定不只看码值，也看文案 —— MiniMax 的 1004 文案是
   「login fail: Please carry the API secret key in the 'Authorization' field」，
   智谱的 401 文案是「令牌已过期或验证不正确」。 */
const AUTH_CODES = [401, 403, 1002, 1004, 1024];

const AUTH_MSG_RE = /(login\s?fail|invalid\s+(api\s*)?key|invalid\s+token|token\s+is\s+invalid|unauthorized|forbidden|令牌|密钥|鉴权|认证|无权限|权限不足)/i;

function isAuthError(code, msg) {
  const n = Number(code);
  if (Number.isFinite(n) && AUTH_CODES.indexOf(n) >= 0) return true;
  return AUTH_MSG_RE.test(String(msg == null ? '' : msg));
}

/* 平台错误 → 抛错。认证类与其它错误码走两条文案，测试盯着这两条不许混。 */
function platformFail(code, msg) {
  const c = (code == null || code === '') ? '' : String(code);
  const m = String(msg == null ? '' : msg).trim();
  if (isAuthError(c, m)) {
    return fail(502, '密钥无效或没有该接口的权限（平台返回 ' + (c || '错误') + (m ? '：' + m : '') + '）', 'AUTH');
  }
  return fail(502, '平台返回错误码 ' + (c || '未知') + (m ? '：' + m : ''), 'PLATFORM');
}

/* 智谱：错误裹在 HTTP 200 里（body.code + body.success） */
function zhipuError(body) {
  if (!body || typeof body !== 'object') return null;
  const code = body.code;
  const n = Number(code);
  const hasNum = code != null && code !== '' && Number.isFinite(n);
  const failed = body.success === false || (hasNum && n !== 0 && n !== 200);
  if (!failed) return null;
  return { code: code, msg: body.msg || body.message || '' };
}

/* MiniMax：错误在 base_resp 里（status_code != 0 即失败，0 是成功） */
function minimaxError(body) {
  const br = body && body.base_resp;
  if (!br || typeof br !== 'object') return null;
  const n = Number(br.status_code);
  if (!Number.isFinite(n) || n === 0) return null;
  return { code: br.status_code, msg: br.status_msg || '' };
}

/* OpenAI 兼容形状：顶层 error 对象（多数平台 401/403 直接走 HTTP 状态码，
   这里兜住「HTTP 200 但带 error 对象」的那几家） */
function openaiError(body) {
  if (!body || typeof body !== 'object') return null;
  const err = body.error;
  if (err == null) return null;
  if (typeof err === 'string') return { code: null, msg: err };
  if (typeof err === 'object') {
    return { code: err.code != null ? err.code : err.type, msg: err.message || err.msg || '' };
  }
  return null;
}

/* ================= 通用取值 ================= */

function pickNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = num(obj[k]);
    if (v != null) return v;
  }
  return null;
}

function pickStr(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (v == null || typeof v === 'object') continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/* 本层 + 一层嵌套里找：MiniMax 这类把余量裹在 data 里的形状用得上 */
function pickNumDeep(obj, keys) {
  const direct = pickNum(obj, keys);
  if (direct != null) return direct;
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const child = obj[k];
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        const v = pickNum(child, keys);
        if (v != null) return v;
      }
    }
  }
  return null;
}

/* ================= 余额接口目录 =================
   path 一律相对域名根路径构造，避免用户 Base URL 带不带 /v1 造成偏差。 */

const BALANCE_APIS = [
  {
    id: 'deepseek',
    re: /(^|\.)deepseek\.com$/i,
    path: '/user/balance',
    parse: function (body) {
      const infos = (body && Array.isArray(body.balance_infos)) ? body.balance_infos : [];
      const cny = infos.find(function (x) { return x.currency === 'CNY'; }) || infos[0];
      const v = cny ? num(cny.total_balance) : null;
      if (v == null) throw parseFailBalance();
      return { value: v, status: 'ok' };
    }
  },
  {
    id: 'moonshot',
    re: /(^|\.)moonshot\.(cn|ai)$|(^|\.)kimi\.(com|ai)$/i,
    path: '/v1/users/me/balance',
    parse: function (body) {
      const d = body && body.data;
      const v = d ? num(d.available_balance) : null;
      if (v == null) throw parseFailBalance();
      return { value: v, status: 'ok' };
    }
  },
  {
    id: 'zhipu',
    re: /(^|\.)bigmodel\.cn$/i,
    path: '/api/biz/account/query-customer-account-report',
    error: zhipuError,
    parse: function (body) {
      const d = body && body.data;
      const v = d ? num(d.balance) : null;
      if (v == null) throw parseFailBalance();
      return { value: v, status: 'ok' };
    }
  },
  {
    id: 'stepfun',
    re: /(^|\.)stepfun\.com$/i,
    path: '/v1/accounts',
    /* 官方文档 platform.stepfun.com/docs/api-reference/accounts/get。
       实测响应：{object:"account", type:"prepaid", balance:0.00,
       total_cash_balance:0.00, total_voucher_balance:26.00} ——
       balance 那一项是**现金**部分，可用额度是现金 + 代金券。
       分项拿不到时才退回 balance。 */
    parse: function (body) {
      const b = body || {};
      const cash = num(b.total_cash_balance);
      const voucher = num(b.total_voucher_balance);
      let v = null;
      if (cash != null || voucher != null) v = (cash || 0) + (voucher || 0);
      else v = num(b.balance);
      if (v == null) throw parseFailBalance();
      return { value: v, status: 'ok' };
    }
  },
  {
    id: 'siliconflow',
    re: /(^|\.)siliconflow\.cn$/i,
    path: '/v1/user/info',
    /* 这条接口曾被记成「2026-08-14 官方下线（410），替代接口未发布」——
       那是错的。2026-10-21 实测：假 key 打 /v1/user/info 回 401「Token is invalid」，
       同一域名打一个明显不存在的路径回 404 ⇒ 路径存在，接口还活着。
       解析按 OpenAI 兼容常见形状：优先 data.balance，再退 balance。 */
    parse: function (body) {
      const d = (body && body.data) || {};
      let v = num(d.balance);
      if (v == null) v = num(body && body.balance);
      if (v == null) throw parseFailBalance();
      return { value: v, status: 'ok' };
    }
  },
  {
    id: 'minimax',
    re: /(^|\.)minimaxi\.com$|(^|\.)minimax\.(chat|io)$/i,
    path: '/v1/token_plan/remains',
    error: minimaxError,
    /* 套餐余量。成功响应的具体字段名没有公开文档（实测只拿到认证失败的
       base_resp），这里按「remain 类字段 + data 下一层」容错取值。
       单位以平台为准（可能是积分/token 数），只如实转达数值。 */
    parse: function (body) {
      const v = pickNumDeep(body, ['remain', 'remaining', 'remain_amount', 'remain_balance',
        'remain_quota', 'remain_tokens', 'remain_point', 'total_remain', 'current_remain',
        'balance', 'total_balance']);
      if (v == null) throw parseFailBalance();
      return { value: v, status: 'ok' };
    }
  },
  {
    id: 'openrouter',
    re: /(^|\.)openrouter\.ai$/i,
    path: '/api/v1/credits',
    /* OpenRouter 不在本项目的平台目录里（platform-catalog.json 没动），
       按域名匹配生效：自定义平台指向 openrouter.ai 同样能查。 */
    parse: function (body) {
      const d = (body && body.data) || {};
      let v = num(d.remaining_credits);
      if (v == null) v = num(d.remaining);
      if (v == null) {
        const total = num(d.total_credits);
        const used = num(d.total_usage);
        if (total != null && used != null) v = total - used;
      }
      if (v == null) v = num(d.balance);
      if (v == null) throw parseFailBalance();
      return { value: v, status: 'ok' };
    }
  },
  {
    id: 'novita',
    re: /(^|\.)novita\.ai$/i,
    path: '/v3/user/balance',
    parse: function (body) {
      const d = (body && body.data) || {};
      let v = num(d.balance);
      if (v == null) v = num(body && body.balance);
      if (v == null) v = num(d.remaining_balance);
      if (v == null) throw parseFailBalance();
      return { value: v, status: 'ok' };
    }
  }
];

/* ================= 用量/限流窗口接口目录 =================
   对外形状统一：{ windows: [{ name, used, limit, resetAt }], kind, raw }
   · kind='quota'：限流/配额窗口（5 小时、7 天、30 天…）
   · kind='cost'：账期费用（不是配额窗口，是花了多少钱）
   · raw 是平台原始响应（数字与文案，不含任何密钥与请求头） */

const USAGE_APIS = [
  {
    id: 'zhipu',
    re: /(^|\.)bigmodel\.cn$/i,
    path: '/api/monitor/usage/quota/limit',
    kind: 'quota',
    error: zhipuError,
    /* 认证失败实测：HTTP 200 + {code:401, msg:"令牌已过期或验证不正确", success:false}。
       成功响应的字段名没有公开文档（这是控制台内部接口，公开 OpenAPI 规范里没有），
       所以下面按形状寻址：数组里每条能同时读出「已用/上限」的就算一个窗口。 */
    parse: function (body) {
      const windows = extractWindows(body);
      if (!windows.length) throw parseFailUsage();
      return { windows: windows, kind: 'quota', raw: body };
    }
  },
  {
    id: 'anthropic',
    re: /(^|\.)anthropic\.com$/i,
    path: '/v1/organizations/usage/costs',
    kind: 'cost',
    /* 这个接口要**组织管理员密钥**（sk-ant-admin…），普通项目密钥一律 403。
       事实写进错误提示里，别让用户拿普通 key 反复试。 */
    httpError: function (status) {
      if (status === 403) return '该用量接口需要组织管理员密钥（sk-ant-admin…），普通项目密钥会返回 HTTP 403';
      if (status === 401) return '密钥无效或不是组织管理员密钥（HTTP 401）';
      return null;
    },
    parse: function (body) {
      const d = (body && body.data) || body || {};
      const used = num(d.total_cost != null ? d.total_cost : d.total);
      if (used == null) throw parseFailUsage();
      return {
        windows: [{
          name: '账期',
          used: used,
          limit: null,
          resetAt: d.ending_at != null ? String(d.ending_at) : null
        }],
        kind: 'cost',
        raw: body
      };
    }
  }
];

/* ================= 窗口条目的形状寻址 =================
   各家字段名不同（used/usage/…、limit/total/quota/…、reset_at/expire_at/…），
   按形状寻址而不是按平台写死字段名。 */
const WINDOW_USED_KEYS = ['used', 'used_count', 'usedCount', 'usage', 'usage_count', 'usageCount',
  'consumed', 'consume', 'current_usage', 'currentUsage', 'used_quota', 'usedQuota',
  'cost', 'total_cost', 'totalCost'];
const WINDOW_LIMIT_KEYS = ['limit', 'limit_count', 'limitCount', 'total', 'max', 'quota',
  'total_quota', 'totalQuota', 'allowance', 'max_count', 'capacity', 'total_limit'];
const WINDOW_RESET_KEYS = ['reset_at', 'resetAt', 'reset_time', 'resetTime', 'next_reset', 'nextReset',
  'expire_at', 'expireAt', 'expire_time', 'refresh_at', 'refreshAt', 'next_refresh', 'nextRefresh'];
const WINDOW_NAME_KEYS = ['name', 'label', 'window', 'window_name', 'windowName', 'period',
  'quota_name', 'quotaName', 'title', 'desc', 'description', 'type'];

/* 窗口名说人话：平台给的是「5小时积分」「每周积分」「5h」这类标签，
   界面上要能一眼看懂是哪个窗口。 */
function humanWindowName(raw, index) {
  const s = String(raw == null ? '' : raw).trim();
  if (s) {
    if (/^5\s*h$/i.test(s) || /5\s*(小时|小時|hour)/i.test(s)) return '5 小时';
    if (/(周|週|星期|week)/i.test(s) || /\b7\s*(天|日|day|d)\b/i.test(s)) return '7 天';
    if (/(月|month)/i.test(s) || /\b30\s*(天|日|day|d)\b/i.test(s)) return '30 天';
    if (/(日|天|daily)/i.test(s) || /\b1\s*(天|日|day|d)\b/i.test(s) || /24\s*(小时|小時|hour)/i.test(s)) return '1 天';
    if (/(小时|小時|hour)/i.test(s)) return '小时窗口';
    return s;
  }
  return '额度 ' + String((index || 0) + 1);
}

function windowOf(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const used = pickNum(obj, WINDOW_USED_KEYS);
  const limit = pickNum(obj, WINDOW_LIMIT_KEYS);
  const resetAt = pickStr(obj, WINDOW_RESET_KEYS);
  const rawName = pickStr(obj, WINDOW_NAME_KEYS);
  if (used == null && limit == null) return null;
  /* 只有一项时必须有名字或重置时间，否则多半是别的字段撞名（撞上了就是假窗口） */
  if ((used == null || limit == null) && !rawName && !resetAt) return null;
  return {
    name: humanWindowName(rawName, 0),
    used: used,
    limit: limit,
    resetAt: resetAt
  };
}

/* 递归找窗口：先当窗口读，命中就不往里钻；没命中再逐层往下找数组/对象 */
function collectWindows(node, depth, out) {
  if (node == null || depth > 4) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const w = windowOf(item);
        if (w) {
          out.push(w);
          continue;
        }
      }
      collectWindows(item, depth + 1, out);
    }
    return;
  }
  if (typeof node !== 'object') return;
  const w = windowOf(node);
  if (w) { out.push(w); return; }
  for (const k of Object.keys(node)) collectWindows(node[k], depth + 1, out);
}

function extractWindows(body) {
  const out = [];
  collectWindows(body, 0, out);
  /* 名字补位：没名字的按出现顺序编号（humanWindowName 里 index 从 1 起） */
  return out.map(function (w, i) {
    return {
      name: /^额度 \d+$/.test(w.name) ? '额度 ' + String(i + 1) : w.name,
      used: w.used,
      limit: w.limit,
      resetAt: w.resetAt
    };
  });
}

/* ================= 对外出口 ================= */

function matchApi(list, url) {
  const h = hostOf(url);
  if (!h) return null;
  for (let i = 0; i < list.length; i++) {
    if (list[i].re.test(h)) return list[i];
  }
  return null;
}

function matchBalanceApi(url) { return matchApi(BALANCE_APIS, url); }
function matchUsageApi(url) { return matchApi(USAGE_APIS, url); }
function supportsBalanceUrl(url) { return !!matchBalanceApi(url); }
function supportsUsageUrl(url) { return !!matchUsageApi(url); }

/* 先判平台错误码，再谈解析 —— 这一层是本次修的核心 */
function detectError(api, body) {
  if (api && typeof api.error === 'function') {
    const e = api.error(body);
    if (e) return e;
  }
  return openaiError(body);
}

function parseBalanceBody(api, body) {
  const err = detectError(api, body);
  if (err) throw platformFail(err.code, err.msg);
  return api.parse(body);
}

function parseUsageBody(api, body) {
  const err = detectError(api, body);
  if (err) throw platformFail(err.code, err.msg);
  return api.parse(body);
}

/* ================= 实测无公开接口的平台（不实现，写清楚免得下轮又试） =================
   · 商汤日日新 SenseNova：/v1/user/info 与 /v1/usage 都是 404，额度只在控制台看。
   · 美团 LongCat：/openai/v1/usage、/v1/usage、/openai/v1/user/usage、/openai/v1/user/info 全 404。
   · 火山方舟：/api/v3/usage 存在，但真路径与假路径都回 401，无法用状态码区分，不接。
   · OpenAI /v1/usage 与 xAI /v1/billing/credits：本机网络不可达（fetch failed），不接。 */

module.exports = {
  BALANCE_APIS: BALANCE_APIS,
  USAGE_APIS: USAGE_APIS,
  matchBalanceApi: matchBalanceApi,
  matchUsageApi: matchUsageApi,
  supportsBalanceUrl: supportsBalanceUrl,
  supportsUsageUrl: supportsUsageUrl,
  parseBalanceBody: parseBalanceBody,
  parseUsageBody: parseUsageBody,
  extractWindows: extractWindows,
  humanWindowName: humanWindowName,
  isAuthError: isAuthError
};
