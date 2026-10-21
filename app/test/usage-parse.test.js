/* 限额/用量接口的解析与请求构造。
   这一组用的**都是厂商真实响应样本**（2026-10-21 查到的，不是构造的形状）：

   · 智谱 Coding Plan 的 monitor 接口形状：GitHub wiki（opencode-glm-quota）、
     cc-switch 的 issue #1588、DSH 的 dsh-plan-usage 插件文档 —— 三处独立来源一致。
   · MiniMax Token Plan：cc-minimax-status 的 README 与 minimax-usage 的说明 —— 两处一致。

   盯的是四件事：
   ① 智谱的窗口身份靠 type + unit + number 三件套（平台不给现成名字）；
      额度值 TOKENS_LIMIT 给的是**百分比**、TIME_LIMIT 给的是**绝对次数**，两者不能混。
   ② MiniMax 的 model_remains 形状：remaining 是**剩余**、total 是**总额**，
      used 要自己算差；remains_time 是**距重置的毫秒数**，不是时间戳。
   ③ 智谱 monitor 接口的认证是**裸 token**（不带 Bearer）—— 三处来源都这么写。
   ④ 「近 24 小时调用次数」是智谱的**另一个**接口（model-usage，要带时间窗参数），
      跟限额窗口同域名不同路径 ⇒ 按条目内部的「附加接口」查，不是靠域名区分。 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const adapters = require('../src/adapters');
const ba = require('../src/balance-apis');

/* ---------- 真实响应样本 ---------- */

const ZHIPU_QUOTA_BODY = {
  code: 200, msg: '操作成功', success: true,
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40.5, nextResetTime: 1737651600000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 52.0, nextResetTime: 1737910800000 },
      {
        type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 123, remaining: 877,
        percentage: 12.3, nextResetTime: 1738256400000
      }
    ],
    level: 'pro'
  }
};

const ZHIPU_MODEL_USAGE_BODY = {
  totalTokens: 7477320,
  totalCalls: 135,
  models: [
    { modelCode: 'glm-4-flash', tokenCount: 5234100, callCount: 78, successCount: 76, errorCount: 2 },
    { modelCode: 'glm-4-plus', tokenCount: 2243220, callCount: 57, successCount: 57, errorCount: 0 }
  ]
};

const MINIMAX_MODEL_REMAINS_BODY = {
  model_remains: [
    { model_name: 'general', remaining: 431, total: 600, remains_time: 720046 },
    { model_name: 'video', remaining: 0, total: 0, remains_time: 360046 }
  ]
};

const MINIMAX_PERCENT_BODY = {
  remaining_percent_5h: 76,
  reset_time: 1738256400000
};

function zhipuApi() { return ba.USAGE_APIS.filter(function (x) { return x.id === 'zhipu'; })[0]; }
function minimaxApi() { return ba.USAGE_APIS.filter(function (x) { return x.id === 'minimax'; })[0]; }

/* ---------- 1. 智谱：窗口身份与两套额度值 ---------- */

test('智谱：按真实形状解析出三个窗口，百分比与次数分开', () => {
  const out = ba.parseUsageBody(zhipuApi(), ZHIPU_QUOTA_BODY);
  assert.strictEqual(out.windows.length, 3, '应当解析出三个窗口');
  assert.deepStrictEqual(out.windows.map(function (w) { return w.name; }),
    ['5 小时 token 限额', '每周 token 限额', '每月 工具调用'],
    '窗口名没按 type+unit+number 还原');
  /* TOKENS_LIMIT 只给百分比：上限就是 100，单位是 % */
  assert.strictEqual(out.windows[0].used, 40.5);
  assert.strictEqual(out.windows[0].limit, 100);
  assert.strictEqual(out.windows[0].unit, '%');
  assert.strictEqual(out.windows[1].used, 52);
  assert.strictEqual(out.windows[1].unit, '%');
  /* TIME_LIMIT 给绝对次数：总额 usage、已用 currentValue */
  assert.strictEqual(out.windows[2].used, 123);
  assert.strictEqual(out.windows[2].limit, 1000);
  assert.strictEqual(out.windows[2].unit, '次');
  assert.ok(out.windows[0].resetAt, '重置时间没解析出来');
  assert.strictEqual(out.kind, 'quota');
});

test('智谱：认证失败要说「密钥无效」，不是「没解析出金额」', () => {
  const body = { code: 401, msg: '令牌已过期或验证不正确', success: false };
  let err = null;
  try { ba.parseUsageBody(zhipuApi(), body); } catch (e) { err = e; }
  assert.ok(err, '认证失败应当抛错');
  assert.match(err.message, /密钥|令牌|权限/, '错误文案没说清是认证问题：' + err.message);
  assert.doesNotMatch(err.message, /未能解析出金额/, '认证失败被说成解析失败，那会误导用户');
});

/* ---------- 2. MiniMax：剩余/总额自己算差 ---------- */

test('MiniMax：model_remains 形状 —— used 是总额减剩余，remains_time 是距重置的毫秒数', () => {
  const out = ba.parseUsageBody(minimaxApi(), MINIMAX_MODEL_REMAINS_BODY);
  const general = out.windows.filter(function (w) { return w.name === 'general'; })[0];
  assert.ok(general, '没有 general 这个窗口');
  assert.strictEqual(general.limit, 600, 'total 应作为上限');
  assert.strictEqual(general.used, 169, 'used 应当是 total - remaining（600-431）');
  assert.strictEqual(general.unit, '次');
  assert.ok(general.resetAt, 'remains_time 没换算成重置时间');
  /* 剩余为 0 的窗口也要算出来（used = total - 0 = 0，不是「没有数据」） */
  const video = out.windows.filter(function (w) { return w.name === 'video'; })[0];
  assert.ok(video, 'remaining=0 的窗口被丢了');
  assert.strictEqual(video.used, 0);
});

test('MiniMax：百分比形状也能解析（国际版）', () => {
  const out = ba.parseUsageBody(minimaxApi(), MINIMAX_PERCENT_BODY);
  assert.strictEqual(out.windows.length, 1);
  assert.strictEqual(out.windows[0].used, 76);
  assert.strictEqual(out.windows[0].limit, 100);
  assert.strictEqual(out.windows[0].unit, '%');
});

test('MiniMax：是限额接口，不是余额接口 —— 别再拿它当余额查', () => {
  assert.strictEqual(ba.supportsBalanceUrl('https://api.minimaxi.com/v1'), false,
    'MiniMax 不该被当余额接口查（它的公开接口是限额窗口，余额在网页控制台）');
  assert.strictEqual(ba.supportsUsageUrl('https://api.minimaxi.com/v1'), true,
    'MiniMax 应当能被当成限额接口查');
});

/* ---------- 3. 请求构造：裸 token + 查询参数 + 附加接口 ---------- */

test('智谱 monitor 接口用**裸 token**（不带 Bearer）', async () => {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url: String(url), headers: init.headers });
    const body = String(url).indexOf('model-usage') > -1 ? ZHIPU_MODEL_USAGE_BODY : ZHIPU_QUOTA_BODY;
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));
  };
  const out = await adapters.fetchUsage('zhipu',
    { url: 'https://open.bigmodel.cn/api/paas/v4', style: 'openai' },
    'sk-zhipu-raw-token-test', { fetchImpl: fetchImpl });

  assert.strictEqual(calls.length, 2, '应当查两个接口：限额窗口 + 近 24 小时调用次数');
  assert.ok(String(calls[0].url).indexOf('/api/monitor/usage/quota/limit') > -1,
    '第一个请求不是限额窗口：' + calls[0].url);
  assert.strictEqual(calls[0].headers.Authorization, 'sk-zhipu-raw-token-test',
    '监控接口的 Authorization 应当是裸 token，不带 Bearer');
  assert.strictEqual(calls[0].headers.Authorization.indexOf('Bearer '), -1,
    '监控接口不该带 Bearer 前缀');

  /* 第二个是 model-usage：带 24 小时时间窗参数 */
  assert.ok(String(calls[1].url).indexOf('/api/monitor/usage/model-usage') > -1,
    '第二个请求不是 model-usage：' + calls[1].url);
  assert.ok(/startTime=/.test(calls[1].url) && /endTime=/.test(calls[1].url),
    'model-usage 应当带 startTime/endTime：' + calls[1].url);

  /* 两边的窗口都要在结果里 */
  const names = out.windows.map(function (w) { return w.name; });
  assert.ok(names.indexOf('5 小时 token 限额') > -1, '缺限额窗口');
  assert.ok(names.indexOf('近 24 小时') > -1, '缺「近 24 小时」窗口');
  const day = out.windows.filter(function (w) { return w.name === '近 24 小时'; })[0];
  assert.strictEqual(day.used, 135, '调用次数没解析出来');
  assert.strictEqual(day.unit, '次');
});

test('附加接口查不到时不拖累主接口（少一行，不是整次查询失败）', async () => {
  const fetchImpl = function (url) {
    const body = String(url).indexOf('model-usage') > -1
      ? { code: 403, msg: '没有权限', success: false }
      : ZHIPU_QUOTA_BODY;
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));
  };
  const out = await adapters.fetchUsage('zhipu',
    { url: 'https://open.bigmodel.cn/api/paas/v4', style: 'openai' },
    'sk-zhipu-test', { fetchImpl: fetchImpl });
  assert.strictEqual(out.windows.length, 3, '主接口的三个窗口应当照样在');
});
