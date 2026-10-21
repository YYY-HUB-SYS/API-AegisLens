/* 余额 + 用量/限流窗口：真协议会话 + 老库升级 + 两个后端逐字一致。
   盯这几件事：
   ① 余额是 **Key 级** 的：各平台按实测响应形状解析出金额；
   ② 用量/限流是 **账户级** 的：窗口的 name/used/limit/resetAt 要对得上；
   ③ **认证失败被平台裹在 HTTP 200 里**（智谱 body.code、MiniMax body.base_resp）时，
      错误文案必须说「密钥无效/没权限」，不能说「没解析出金额」——
      后者会让用户以为平台返回了正常数据、只是格式变了；
   ④ 老 SQLite 库缺 usage 列时，升级后必须能打开（缺 ALTER TABLE 就起不来）；
   ⑤ 两个后端给出一模一样的结果。

   ★ 不 mock 库函数：起本地假服务端，用注入的 fetchImpl 打它，
     走真实 HTTP 连接、真实请求头、真实响应体 —— 只把落点换成本地端口。 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const tmp = require('./tmp.js');
const adapters = require('../src/adapters');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');

/* 三种密钥：正常 / 认证失败 / 返回了但取不出金额 */
const GOOD = 'sk-good';
const BAD = 'sk-bad';
const FLAT = 'sk-flat';
const EMPTY = 'sk-empty';

/* 各平台的响应形状按**实测**来（假 key 打真实端点得到的那些）。
   智谱与 MiniMax 的失败是 HTTP 200 里裹着错误码 —— 这正是本轮要修的坑。 */
const ROUTES = {
  '/user/balance': {
    ok: { status: 200, body: { is_available: true, balance_infos: [
      { currency: 'CNY', total_balance: '110.50' },
      { currency: 'USD', total_balance: '0.00' }
    ] } },
    bad: { status: 401, body: { error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' } } },
    empty: { status: 200, body: { is_available: true, balance_infos: [] } }
  },
  '/v1/users/me/balance': {
    ok: { status: 200, body: { data: { available_balance: '12.34' } } },
    bad: { status: 401, body: { error: { message: 'invalid api key', code: 'invalid_api_key' } } }
  },
  '/api/biz/account/query-customer-account-report': {
    ok: { status: 200, body: { code: 200, msg: '操作成功', data: { balance: 99.2273858, rechargeAmount: 100, giveAmount: 0 } } },
    bad: { status: 200, body: { code: 401, msg: '令牌已过期或验证不正确', success: false } }
  },
  '/v1/accounts': {
    ok: { status: 200, body: { object: 'account', type: 'prepaid', balance: 0, total_cash_balance: 0, total_voucher_balance: 26 } },
    bad: { status: 401, body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } } }
  },
  '/v1/user/info': {
    ok: { status: 200, body: { code: 200, message: 'success', data: { balance: '18.50', totalBalance: '20.00' } } },
    flat: { status: 200, body: { balance: '5.25' } },
    bad: { status: 401, body: { error: { message: 'Token is invalid', code: '401' } } }
  },
  /* MiniMax Token Plan（真实形状，2026-10-21 查 cc-minimax-status / minimax-usage 两处一致）：
     model_remains[] 里 remaining 是**剩余**、total 是**总额**、remains_time 是距重置的毫秒数。 */
  '/v1/token_plan/remains': {
    ok: { status: 200, body: { model_remains: [
      { model_name: 'general', remaining: 431, total: 600, remains_time: 720046 }
    ] } },
    bad: { status: 200, body: { base_resp: { status_code: 1004, status_msg: "login fail: Please carry the API secret key in the 'Authorization' field of the request header" } } }
  },
  '/api/v1/credits': {
    ok: { status: 200, body: { data: { total_credits: 100, total_usage: 25, remaining_credits: 75 } } },
    bad: { status: 401, body: { error: { message: 'No auth credentials found', code: 401 } } }
  },
  '/v3/user/balance': {
    ok: { status: 200, body: { data: { balance: 42.5 } } },
    bad: { status: 403, body: { error: { message: 'Invalid API key', code: 403 } } }
  },
  /* 智谱 Coding Plan 的 monitor 接口（真实形状，2026-10-21 查到，
     GitHub wiki / cc-switch issue #1588 / DSH 插件三处独立来源一致）：
     窗口身份是 type + unit + number 三件套（unit 3=小时 5=月 6=周），
     TOKENS_LIMIT 只给**百分比**（percentage 0-100），TIME_LIMIT 给绝对次数。 */
  '/api/monitor/usage/quota/limit': {
    ok: { status: 200, body: { code: 200, msg: '操作成功', success: true, data: { limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40.5, nextResetTime: 1737651600000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 52.0, nextResetTime: 1737910800000 },
      { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 123, remaining: 877, percentage: 12.3, nextResetTime: 1738256400000 }
    ], level: 'pro' } } },
    /* 平台改字段名时的样子：认不出 limits[] 会退回通用形状寻址，窗口照样认得出 */
    flat: { status: 200, body: { code: 200, msg: 'success', data: { list: [
      { name: '5小时积分', used: 1200, limit: 12000, resetAt: '2026-10-21T20:00:00+08:00' }
    ] } } },
    bad: { status: 200, body: { code: 401, msg: '令牌已过期或验证不正确', success: false } }
  },
  /* 智谱「近 24 小时用了多少次」—— 与限额窗口同域名的另一个接口，
     带 24 小时时间窗参数（用户要的三格里的「调用次数」）。 */
  '/api/monitor/usage/model-usage': {
    ok: { status: 200, body: { totalTokens: 7477320, totalCalls: 135, models: [
      { modelCode: 'glm-4-flash', tokenCount: 5234100, callCount: 78, successCount: 76, errorCount: 2 }
    ] } },
    bad: { status: 200, body: { code: 401, msg: '令牌已过期或验证不正确', success: false } }
  },
  '/v1/organizations/usage/costs': {
    ok: { status: 200, body: {
      starting_at: '2026-10-01T00:00:00Z',
      ending_at: '2026-10-31T00:00:00Z',
      currency: 'USD',
      total_cost: '12.34'
    } },
    bad: { status: 403, body: { type: 'error', error: { type: 'permission_error', message: 'You must be an organization admin to use this endpoint' } } }
  }
};

function startServer() {
  const seen = [];
  const server = http.createServer(function (req, res) {
    const auth = String(req.headers.authorization || '');
    const xkey = String(req.headers['x-api-key'] || '');
    const key = auth.replace(/^Bearer\s+/i, '') || xkey;
    seen.push({ path: req.url, key: key, headers: req.headers });
    const route = ROUTES[String(req.url).split('?')[0]];
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const variant = key === BAD ? route.bad : (key === EMPTY ? route.empty : (key === FLAT ? route.flat : route.ok));
    if (!variant) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    res.writeHead(variant.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(variant.body));
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      resolve({
        server: server,
        port: port,
        seen: seen,
        /* 厂商域名换成本地端口：路径、请求头、响应体全是真的，
           只换落点 —— 这样「域名匹配 → 拼路径 → 带密钥发请求」整条链路都在跑。 */
        fetchImpl: function (url, init) {
          const u = new URL(String(url));
          return fetch('http://127.0.0.1:' + port + u.pathname + u.search, init);
        }
      });
    });
  });
}

function stopServer(server) {
  return new Promise(function (resolve) { server.close(function () { resolve(); }); });
}

const backends = [];
try {
  require('node:sqlite');
  backends.push('sqlite');
} catch (e) { /* 当前 Node 不支持，跳过 */ }
backends.push('json');

function seedKey(store, name) {
  return store.createKey({
    name: name, platform: 'custom', customName: '', key: 'sk-usage-store-0001',
    base: 'https://api.deepseek.com', model: '', reg: '', exp: ''
  });
}

/* ---------- 余额 ---------- */

test('余额：各平台按实测响应形状解析出金额', async () => {
  const s = await startServer();
  try {
    const cases = [
      { ep: { url: 'https://api.deepseek.com', style: 'openai' }, path: '/user/balance', value: 110.5 },
      { ep: { url: 'https://api.moonshot.cn/v1', style: 'openai' }, path: '/v1/users/me/balance', value: 12.34 },
      { ep: { url: 'https://open.bigmodel.cn/api/paas/v4', style: 'openai' }, path: '/api/biz/account/query-customer-account-report', value: 99.2273858 },
      { ep: { url: 'https://api.stepfun.com/v1', style: 'openai' }, path: '/v1/accounts', value: 26 },
      { ep: { url: 'https://api.siliconflow.cn/v1', style: 'openai' }, path: '/v1/user/info', value: 18.5 },
      { ep: { url: 'https://openrouter.ai/api/v1', style: 'openai' }, path: '/api/v1/credits', value: 75 },
      { ep: { url: 'https://api.novita.ai/v3', style: 'openai' }, path: '/v3/user/balance', value: 42.5 }
    ];
    for (const c of cases) {
      const bal = await adapters.fetchBalance('custom', c.ep, GOOD, { fetchImpl: s.fetchImpl });
      assert.ok(bal, c.path + ' 应当可查');
      assert.strictEqual(bal.value, c.value, c.path + ' 金额解析不对');
      assert.strictEqual(bal.status, 'ok');
      assert.ok(s.seen.some(function (r) { return r.path === c.path; }), '服务端应收到 ' + c.path);
    }
    /* 请求要真的带上密钥，否则测的是「不带密钥也能查」的假象 */
    const first = s.seen[0];
    assert.strictEqual(first.headers.authorization, 'Bearer ' + GOOD);
  } finally {
    await stopServer(s.server);
  }
});

test('余额：硅基流动的 /v1/user/info 重新启用（注释说已下线是错的）', async () => {
  const s = await startServer();
  try {
    const bal = await adapters.fetchBalance('siliconflow', { url: 'https://api.siliconflow.cn/v1', style: 'openai' }, GOOD, { fetchImpl: s.fetchImpl });
    assert.ok(bal, '硅基流动余额接口应可查');
    assert.strictEqual(bal.value, 18.5, '优先取 data.balance');
    /* 容错：没有 data 时退回顶层 balance */
    const flat = await adapters.fetchBalance('siliconflow', { url: 'https://api.siliconflow.cn/v1', style: 'openai' }, FLAT, { fetchImpl: s.fetchImpl });
    assert.strictEqual(flat.value, 5.25, '没有 data 时退回 balance');
    assert.strictEqual(adapters.supportsBalanceUrl('https://api.siliconflow.cn/v1'), true);
  } finally {
    await stopServer(s.server);
  }
});

/* ---------- 用量/限流窗口 ---------- */

test('用量：智谱的限流窗口解析出 name/used/limit/resetAt', async () => {
  const s = await startServer();
  try {
    const u = await adapters.fetchUsage('zhipu', { url: 'https://open.bigmodel.cn/api/paas/v4', style: 'openai' }, GOOD, { fetchImpl: s.fetchImpl });
    assert.ok(u, '智谱用量接口应可查');
    assert.strictEqual(u.kind, 'quota');
    /* 真实形状：窗口身份靠 type+unit+number；TOKENS_LIMIT 给百分比、TIME_LIMIT 给次数 */
    assert.deepStrictEqual(u.windows, [
      { name: '5 小时 token 限额', used: 40.5, limit: 100, resetAt: '2025-01-23T17:00:00.000Z', unit: '%' },
      { name: '每周 token 限额', used: 52, limit: 100, resetAt: '2025-01-26T17:00:00.000Z', unit: '%' },
      { name: '每月 工具调用', used: 123, limit: 1000, resetAt: '2025-01-30T17:00:00.000Z', unit: '次' },
      { name: '近 24 小时', used: 135, limit: null, resetAt: null, unit: '次' }
    ], '窗口名要说人话，数值与重置时间要原样对上（含附加接口的调用次数）');
    assert.ok(s.seen.some(function (r) { return r.path === '/api/monitor/usage/quota/limit'; }));
    /* 监控接口的认证是裸 token：Authorization 里没有 Bearer 前缀 */
    const req = s.seen.filter(function (r) { return r.path === '/api/monitor/usage/quota/limit'; })[0];
    assert.strictEqual(req.headers.authorization, GOOD, '智谱 monitor 接口应当用裸 token');
    assert.strictEqual(String(req.headers.authorization).indexOf('Bearer '), -1, '不该带 Bearer 前缀');
    /* 附加接口（近 24 小时调用次数）也要查，且带 24 小时时间窗参数 */
    const extra = s.seen.filter(function (r) { return String(r.path).indexOf('/api/monitor/usage/model-usage') === 0; })[0];
    assert.ok(extra, '应当同时查「近 24 小时调用次数」那个接口');
    assert.ok(/startTime=/.test(extra.path) && /endTime=/.test(extra.path), '该接口要带时间窗参数');
    assert.ok(u.windows.some(function (w) { return w.name === '近 24 小时' && w.used === 135; }),
      '调用次数没进窗口');
  } finally {
    await stopServer(s.server);
  }
});

test('用量：换个字段名也要认得出窗口（按形状寻址，不按平台写死字段）', async () => {
  const s = await startServer();
  try {
    /* 平台改了字段名（认不出 limits[]）时，退回通用形状寻址，窗口照样认得出 */
    const u = await adapters.fetchUsage('zhipu', { url: 'https://open.bigmodel.cn/api/paas/v4', style: 'openai' }, FLAT, { fetchImpl: s.fetchImpl });
    assert.deepStrictEqual(u.windows, [
      { name: '5 小时', used: 1200, limit: 12000, resetAt: '2026-10-21T20:00:00+08:00', unit: null }
    ]);
  } finally {
    await stopServer(s.server);
  }
});

test('用量：Anthropic 的账期费用（kind=cost）+ 普通项目密钥 403 要说清', async () => {
  const s = await startServer();
  try {
    const u = await adapters.fetchUsage('anthropic', { url: 'https://api.anthropic.com', style: 'anthropic' }, GOOD, { fetchImpl: s.fetchImpl });
    assert.strictEqual(u.kind, 'cost');
    assert.deepStrictEqual(u.windows, [
      { name: '账期', used: 12.34, limit: null, resetAt: '2026-10-31T00:00:00Z' }
    ]);
    const req = s.seen.filter(function (r) { return r.path === '/v1/organizations/usage/costs'; })[0];
    assert.strictEqual(req.headers['x-api-key'], GOOD, 'Anthropic 风格走 x-api-key');
    /* 普通项目密钥会 403 —— 错误提示要说清是「要组织管理员密钥」 */
    await assert.rejects(
      () => adapters.fetchUsage('anthropic', { url: 'https://api.anthropic.com', style: 'anthropic' }, BAD, { fetchImpl: s.fetchImpl }),
      function (e) {
        assert.match(e.message, /组织管理员密钥/);
        assert.doesNotMatch(e.message, /未能解析出/);
        return true;
      }
    );
  } finally {
    await stopServer(s.server);
  }
});

/* ---------- 认证失败 vs 解析失败：两套文案不许混 ---------- */

/* 认证失败的共同要求只有一条：**文案要说清密钥无效/没权限**，
   绝不能说「没解析出金额/窗口」（那是解析层的话，认证失败时是误导）。
   错误码分两种：平台把错误裹在 HTTP 200 里时由我们判，码是 'AUTH'；
   平台直接回 HTTP 401/403 时，码沿用 HTTP 状态码（既有行为，不动）。 */
function assertAuthMessage(e) {
  assert.match(e.message, /密钥|无权限|权限/, '认证失败要说清密钥无效/没权限：' + e.message);
  assert.doesNotMatch(e.message, /未能解析出/, '认证失败不能说「没解析出金额/窗口」：' + e.message);
  return true;
}

test('认证失败（HTTP 200 里裹着错误码）：文案说密钥无效，不是没解析出金额', async () => {
  const s = await startServer();
  try {
    /* 智谱余额：HTTP 200 + {code:401, success:false} */
    await assert.rejects(
      () => adapters.fetchBalance('zhipu', { url: 'https://open.bigmodel.cn/api/paas/v4', style: 'openai' }, BAD, { fetchImpl: s.fetchImpl }),
      function (e) {
        assertAuthMessage(e);
        assert.strictEqual(e.code, 'AUTH', '平台错误码由我们判时，码标 AUTH');
        assert.match(e.message, /401/, '要带上平台给的错误码');
        return true;
      }
    );
    /* MiniMax 限额：HTTP 200 + {base_resp:{status_code:1004}}
       （MiniMax 是限额接口不是余额接口 —— 它的余额在网页控制台，没有公开 API） */
    await assert.rejects(
      () => adapters.fetchUsage('minimax', { url: 'https://api.minimaxi.com/v1', style: 'openai' }, BAD, { fetchImpl: s.fetchImpl }),
      function (e) {
        assertAuthMessage(e);
        assert.strictEqual(e.code, 'AUTH');
        assert.match(e.message, /1004/);
        return true;
      }
    );
    /* 智谱用量：HTTP 200 + {code:401, success:false} */
    await assert.rejects(
      () => adapters.fetchUsage('zhipu', { url: 'https://open.bigmodel.cn/api/paas/v4', style: 'openai' }, BAD, { fetchImpl: s.fetchImpl }),
      function (e) {
        assertAuthMessage(e);
        assert.strictEqual(e.code, 'AUTH');
        return true;
      }
    );
  } finally {
    await stopServer(s.server);
  }
});

test('认证失败（直接 401/403）：同样要说密钥无效', async () => {
  const s = await startServer();
  try {
    const eps = [
      { url: 'https://api.deepseek.com', style: 'openai' },
      { url: 'https://api.siliconflow.cn/v1', style: 'openai' },
      { url: 'https://openrouter.ai/api/v1', style: 'openai' },
      { url: 'https://api.novita.ai/v3', style: 'openai' }
    ];
    for (const ep of eps) {
      await assert.rejects(
        () => adapters.fetchBalance('custom', ep, BAD, { fetchImpl: s.fetchImpl }),
        function (e) {
          assertAuthMessage(e);
          assert.ok(e.code === '401' || e.code === '403', 'HTTP 状态码路径沿用状态码做错误码：' + e.code);
          return true;
        },
        ep.url + ' 的 401/403 也要说密钥无效'
      );
    }
  } finally {
    await stopServer(s.server);
  }
});

test('平台真返回了数据但取不出金额：这时才说「没解析出金额」', async () => {
  const s = await startServer();
  try {
    await assert.rejects(
      () => adapters.fetchBalance('deepseek', { url: 'https://api.deepseek.com', style: 'openai' }, EMPTY, { fetchImpl: s.fetchImpl }),
      function (e) {
        assert.match(e.message, /未能解析出金额/);
        assert.doesNotMatch(e.message, /密钥无效/, '不是认证问题，别报成密钥无效');
        assert.strictEqual(e.code, 'PARSE');
        return true;
      }
    );
  } finally {
    await stopServer(s.server);
  }
});

/* ---------- 存储：两套口径 + 老库升级 + 两个后端一致 ---------- */

test('老 SQLite 库：keys 表缺 usage 三列，升级后能打开且能存 usage', () => {
  const dir = tmp.mk('akm-oldusage-sqlite');
  const mk = loadOrCreateMasterKey(dir);
  const store = createStore(dir, mk, { backend: 'sqlite' });
  const k = seedKey(store, '老库密钥');
  store.close();

  /* 把三列删掉 = 还原成加列之前的表结构。
     只改建表语句（CREATE TABLE IF NOT EXISTS）的话，老库一打开就
     "no such column" —— 服务在老库上根本起不来。 */
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'keys.db'));
  db.exec('ALTER TABLE keys DROP COLUMN usage_json');
  db.exec('ALTER TABLE keys DROP COLUMN usage_status');
  db.exec('ALTER TABLE keys DROP COLUMN usage_updated_at');
  db.close();

  const mk2 = loadOrCreateMasterKey(dir);
  const store2 = createStore(dir, mk2, { backend: 'sqlite' });
  const got = store2.getKey(k.id);
  assert.ok(got, '老库里的密钥要还在');
  assert.strictEqual(got.usage.status, 'pending');
  assert.deepStrictEqual(got.usage.windows, []);

  const saved = store2.saveUsage(k.id, {
    status: 'ok',
    windows: [{ name: '5 小时', used: 1, limit: 2, resetAt: null }],
    kind: 'quota',
    raw: { data: { list: [] } }
  });
  assert.strictEqual(saved.usage.status, 'ok');
  assert.deepStrictEqual(saved.usage.windows, [{ name: '5 小时', used: 1, limit: 2, resetAt: null }]);
  /* 句柄不关 ⇒ Windows 上目录删不掉，%TEMP% 会攒残留 */
  store2.close();
});

/* 两个后端的结论都攒在这里，最后逐字比对 */
const summary = {};

function shapeOf(store, id) {
  const k = store.getKey(id);
  const c = JSON.parse(JSON.stringify({ balance: k.balance, usage: k.usage }));
  /* 时间戳两边必然差几毫秒，比的是业务字段：状态、窗口、数值 */
  if (c.balance) c.balance.updatedAt = '<t>';
  if (c.usage) c.usage.updatedAt = '<t>';
  return c;
}

backends.forEach(function (backend) {
  test('存储后端 ' + backend + '：余额与用量快照各存各的', () => {
    const dir = tmp.mk('akm-usage-' + backend);
    const mk = loadOrCreateMasterKey(dir);
    const store = createStore(dir, mk, { backend: backend });
    try {
      const k = seedKey(store, '口径测试');
      assert.strictEqual(store.getKey(k.id).usage.status, 'pending', '新密钥的用量状态是 pending');
      assert.deepStrictEqual(store.getKey(k.id).usage.windows, []);

      store.saveBalance(k.id, { value: 88.5, status: 'ok' });
      const afterBalance = store.getKey(k.id);
      assert.strictEqual(afterBalance.balance.value, 88.5);
      assert.strictEqual(afterBalance.usage.status, 'pending', '改余额不该动用量快照');

      store.saveUsage(k.id, {
        status: 'ok',
        windows: [{ name: '5 小时', used: 1200, limit: 12000, resetAt: '2026-10-21T20:00:00+08:00' }],
        kind: 'quota',
        raw: { code: 200, data: { list: [{ name: '5小时积分' }] } }
      });
      const afterUsage = store.getKey(k.id);
      assert.strictEqual(afterUsage.balance.value, 88.5, '改用量不该动余额');
      assert.strictEqual(afterUsage.usage.status, 'ok');
      assert.deepStrictEqual(afterUsage.usage.windows, [
        { name: '5 小时', used: 1200, limit: 12000, resetAt: '2026-10-21T20:00:00+08:00' }
      ]);
      assert.strictEqual(afterUsage.usage.kind, 'quota');
      assert.ok(afterUsage.usage.updatedAt, '快照要有时间戳');
      /* 用量快照里绝不能出现密钥或请求头 */
      const dumped = JSON.stringify(afterUsage.usage);
      assert.strictEqual(dumped.indexOf('sk-usage-store-0001'), -1, '用量快照里不许出现密钥');
      assert.strictEqual(dumped.indexOf('Authorization'), -1, '用量快照里不许出现请求头');

      summary[backend] = shapeOf(store, k.id);
    } finally {
      store.close();
    }
  });
});

test('两个后端的余额/用量快照逐字一致', function () {
  if (!summary.json || !summary.sqlite) return;
  assert.deepStrictEqual(summary.json, summary.sqlite,
    '两个后端给出的余额/用量形态不一样：\njson: ' + JSON.stringify(summary.json, null, 1)
    + '\nsqlite: ' + JSON.stringify(summary.sqlite, null, 1));
});
