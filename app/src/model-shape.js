/* 通用形状提取器
 *
 * 十一家 /v1/models 有十一种互不兼容的字段布局（实测档案见
 * test/fixtures/model-responses/FINDINGS.md）：上下文既可能在顶层 context_length，
 * 也可能叫 context_window，还可能埋在 input_modalities[].supported_inputs
 * .max_context_length.value 里两层深的 {value, unit} 包装中。按平台写死字段名追不上，
 * 所以这里按「形状」寻址：递归找数值叶子，再按键名特异性打分。
 *
 * 一条关键约束：递归遇到 {value|max, unit|per|min|type} 这类数值包装时**不下钻**，
 * 否则 unit 会在到达 unwrap 之前丢失，「单位必须是 token」这道护栏就形同不存在
 * （{"value":262,"unit":"K"} 会被原样提成 262，1000 倍低估）。
 */

'use strict';

/* 数值下限 64：挡掉 temperature.max=2、stop.max_items=4 这类同名不同义的数。
   上限 2 亿：挡掉哨兵值与 50 亿级的 TPM 速率。 */
const MIN_TOKENS = 64;
const MAX_TOKENS = 200000000;

const CTX_EXACT = ['context_length', 'context_window', 'max_context_length', 'context'];
const OUT_EXACT = ['max_output_length', 'max_output_tokens', 'max_output',
  'max_completion_tokens', 'max_length', 'output_length'];
const CTX_PAT = /context|ctx|window/i;
const OUT_PAT = /output|completion|response/i;
/* 速率/价格：路径里出现即整条丢弃，否则 intern 的 capacity.value=5005000000
   会被当成 50 亿上下文的模型 */
const RATE_PAT = /capacity|rate|tpm|rpm|per_minute|requests?\b|price|cost|limit_reached/i;
/* 参数规格容器：里面的 max_tokens.max 是"可传参数取值范围"，不是模型输出上限 */
const PARAM_CONTAINERS = ['supported_parameters', 'parameters', 'supported_sampling_parameters', 'schema'];
const UNIT_OK = ['', 'token', 'tokens'];
const WRAPPER_SIBLINGS = ['unit', 'per', 'min', 'type', 'description'];
const KNOWN_MODALITIES = ['text', 'image', 'audio', 'video', 'file', 'document'];

function toNum(v) {
  if (typeof v === 'boolean' || v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/* 把标量或 {value|max, unit, per, ...} 包装统一成 {val, unit, per}；不是数值则返回 null */
function numericLeaf(v) {
  const direct = toNum(v);
  if (direct !== null) return { val: direct, unit: null, per: null };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;

  const raw = (v.value !== undefined) ? v.value : v.max;
  if (raw === undefined) return null;
  const inner = toNum(raw);
  if (inner === null) return null;
  for (const k of Object.keys(v)) {
    if (k === 'value' || k === 'max') continue;
    if (WRAPPER_SIBLINGS.indexOf(k) < 0) return null;
  }
  return { val: inner, unit: v.unit ? String(v.unit) : null, per: v.per ? String(v.per) : null };
}

function walk(node, names, emit) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) walk(node[i], names, emit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    const leaf = numericLeaf(v);
    if (leaf) emit(k, leaf, names, node);
    else walk(v, names.concat([k]), emit);
  }
}

function score(name, exactList, pat, parentNames) {
  const n = String(name).toLowerCase();
  if (exactList.indexOf(n) >= 0) return 100;
  const parent = parentNames[parentNames.length - 1] || '';
  if (PARAM_CONTAINERS.indexOf(String(parent).toLowerCase()) >= 0) return 0;
  if (n === 'max' || n === 'value') return 0;
  return pat.test(n) ? 70 : 0;
}

/**
 * 从一条模型对象里提取上下文/最大输出。
 * 返回 { ctx, out, ctxSrc, outSrc, outGtCtx }，src 为 'api' 或 null（没提到）。
 */
function extractLimits(item) {
  let bestCtx = null, bestOut = null;

  walk(item, [], function (key, leaf, names, parent) {
    const path = names.concat([key]).join('.');
    if (RATE_PAT.test(path)) return;
    if (leaf.per) return;
    if (leaf.unit && UNIT_OK.indexOf(leaf.unit.toLowerCase()) < 0) return;
    if (leaf.val < MIN_TOKENS || leaf.val > MAX_TOKENS) return;

    const parentNames = names.length ? [names[names.length - 1]] : [];
    const cs = score(key, CTX_EXACT, CTX_PAT, parentNames);
    if (cs > 0 && (!bestCtx || cs > bestCtx.s)) bestCtx = { s: cs, v: leaf.val };
    else {
      const os = score(key, OUT_EXACT, OUT_PAT, parentNames);
      if (os > 0 && (!bestOut || os > bestOut.s)) bestOut = { s: os, v: leaf.val };
    }
  });

  const ctx = bestCtx ? bestCtx.v : null;
  const out = bestOut ? bestOut.v : null;
  return {
    ctx: ctx,
    out: out,
    ctxSrc: ctx !== null ? 'api' : null,
    outSrc: out !== null ? 'api' : null,
    /* 平台自相矛盾：输出上限不可能不小于整个窗口 */
    outGtCtx: (ctx !== null && out !== null && out > ctx) || null
  };
}

function firstBool() {
  for (let i = 0; i < arguments.length; i++) {
    if (typeof arguments[i] === 'boolean') return arguments[i];
  }
  return null;
}

/** 参数规格容器可能挂在模型顶层，也可能挂在 output_modalities[] 里（intern 就是后者） */
function paramSetsOf(item) {
  const out = [];
  function take(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(take); return; }
    const sp = node.supported_parameters;
    if (sp && typeof sp === 'object') out.push(sp);
    ['output_modalities', 'input_modalities'].forEach(function (k) {
      if (Array.isArray(node[k])) node[k].forEach(take);
    });
  }
  take(item);
  return out;
}

/**
 * 能力位：reasoning / 输入模态 / 每分钟请求数。
 * 同一维度各家形态不同（bool、键存在性、枚举成员三种都见过），故逐个尝试。
 */
function extractCaps(item) {
  const caps = { reasoning: null, modalitiesIn: null, rpm: null };

  const prov = (Array.isArray(item.providers) && item.providers.length) ? item.providers[0] : null;
  const sp = paramSetsOf(item)[0];
  const feats = item.supported_features;

  if (prov) caps.reasoning = firstBool(prov.reasoning, caps.reasoning);
  if (sp && !Array.isArray(sp) && typeof sp === 'object') {
    caps.reasoning = ('reasoning' in sp) ? true : caps.reasoning;
  } else if (Array.isArray(sp)) {
    caps.reasoning = (sp.map(String).indexOf('reasoning') >= 0) ? true : caps.reasoning;
  } else if (Array.isArray(feats)) {
    caps.reasoning = (feats.map(String).indexOf('reasoning') >= 0) ? true : caps.reasoning;
  }
  if (typeof item.reasoning === 'boolean') caps.reasoning = item.reasoning;
  /* 明确看到 tools 而无 reasoning 键的，不等于不支持；保持 null 交给人判断 */

  const mods = (item.architecture && item.architecture.input_modalities) || item.input_modalities;
  if (Array.isArray(mods)) {
    const got = [];
    for (let i = 0; i < mods.length; i++) {
      const raw = (mods[i] && typeof mods[i] === 'object') ? mods[i].type : mods[i];
      const m = String(raw || '').toLowerCase();
      /* 按已知枚举过滤：实测有平台在枚举里混了中文 "文本" */
      if (KNOWN_MODALITIES.indexOf(m) >= 0 && got.indexOf(m) < 0) got.push(m);
    }
    if (got.length) caps.modalitiesIn = got;
  }

  const pools = [].concat(item.capacity || [], item.rate_limits || []);
  (Array.isArray(item.input_modalities) ? item.input_modalities : []).forEach(function (m) {
    if (m && Array.isArray(m.capacity)) pools.push.apply(pools, m.capacity);
  });
  for (let i = 0; i < pools.length; i++) {
    const c = pools[i];
    if (c && String(c.type).toLowerCase() === 'request' && String(c.per).toLowerCase() === 'minute') {
      const n = toNum(c.value);
      if (n !== null) { caps.rpm = n; break; }
    }
  }

  if (caps.reasoning === null && caps.modalitiesIn === null && caps.rpm === null) return {};
  return caps;
}

/** 模型标识：有平台不返回 id（实测有只有 name 的形状），回退以免整条被丢弃 */
function modelId(item) {
  const raw = item.id || item.name || item.display_name || item.model;
  return String(raw || '').trim();
}

/**
 * 整条记录的来源标签。两条规则：
 * ① 任一数值来自平台就显示「平台接口」（README 既定语义，也是信任序裁定的结果）；
 * ② 否则取两个字段里**最不可信**的那个 —— 混合来源时宁可低估，
 *    不能让"ctx 来自内置表 + out 来自联网"整条显示成「内置表」。
 * 两边都没提到是 'unknown'，不再回落成 'api' 谎称平台报过。
 */
const SRC_TRUST = { web: 0, meta: 1, manual: 2 };

function summarizeSrc(ctxSrc, outSrc) {
  if (ctxSrc === 'api' || outSrc === 'api') return 'api';
  const s = [ctxSrc, outSrc].filter(Boolean);
  if (!s.length) return 'unknown';
  return s.slice().sort(function (a, b) {
    return (SRC_TRUST[a] === undefined ? -1 : SRC_TRUST[a]) - (SRC_TRUST[b] === undefined ? -1 : SRC_TRUST[b]);
  })[0];
}

/**
 * 取一条记录的按字段来源；库里已存的旧记录只有整条 src、没有 ctxSrc/outSrc，
 * 那就按「两个字段同源」理解，避免重新拉取时把 'web'/'manual' 退化成 'unknown'。
 * 旧数据里"值为空却标 api"的那种谎，在这里会自然落成 'unknown'。
 */
function fieldSrcs(m) {
  if (!m) return { ctxSrc: null, outSrc: null };
  if (m.ctxSrc || m.outSrc) {
    return { ctxSrc: m.ctxSrc || null, outSrc: m.outSrc || null };
  }
  const legacy = (m.src && m.src !== 'unknown') ? m.src : null;
  return {
    ctxSrc: (m.ctx != null) ? legacy : null,
    outSrc: (m.out != null) ? legacy : null
  };
}

/** 响应体里的模型数组：顶层键十一家都是 data，但 {"models":[...]} 与裸数组也真实存在 */
function modelList(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.models)) return body.models;
  return [];
}

module.exports = {
  extractLimits: extractLimits,
  extractCaps: extractCaps,
  modelId: modelId,
  summarizeSrc: summarizeSrc,
  fieldSrcs: fieldSrcs,
  modelList: modelList,
  numericLeaf: numericLeaf,
  MIN_TOKENS: MIN_TOKENS,
  MAX_TOKENS: MAX_TOKENS
};
