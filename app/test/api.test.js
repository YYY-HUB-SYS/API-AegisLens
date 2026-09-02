const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');
const CATALOG = require('../src/platform-catalog.json');

function mockFetch(url, opts) {
  const u = String(url);
  if (u.includes('/user/balance')) {
    return Promise.resolve(new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '88.50' }]
    }), { status: 200 }));
  }
  if (u.includes('/v1/users/me/balance')) {
    return Promise.resolve(new Response(JSON.stringify({
      data: { available_balance: '12.34' }
    }), { status: 200 }));
  }
  if (u.includes('/v1/user/info')) {
    return Promise.resolve(new Response(JSON.stringify({
      data: { totalBalance: '56.78' }
    }), { status: 200 }));
  }
  if (u.includes('/models')) {
    return Promise.resolve(new Response(JSON.stringify({
      data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]
    }), { status: 200 }));
  }
  return Promise.resolve(new Response('{}', { status: 404 }));
}

function mockFetch401(url, opts) {
  return Promise.resolve(new Response('{"error":"invalid"}', { status: 401 }));
}

async function startServer(fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-api-'));
  const mk = loadOrCreateMasterKey(dir);
  const storage = createStore(dir, mk, { backend: 'json' });
  const server = createApp({
    storage: storage,
    fetchImpl: fetchImpl,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test'
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { server: server, base: base };
}

function call(base, method, p, body, headers) {
  return fetch(base + p, {
    method: method,
    headers: Object.assign(
      body ? { 'Content-Type': 'application/json' } : {},
      headers || {}
    ),
    body: body ? JSON.stringify(body) : undefined
  }).then(res => res.json().then(data => ({ status: res.status, data: data })));
}

test('API 集成：完整业务流程', async () => {
  const { server, base } = await startServer(mockFetch);
  try {
    const plat = await call(base, 'GET', '/api/platforms');
    assert.strictEqual(plat.status, 200);
    const ds = plat.data.platforms.find(p => p.id === 'deepseek');
    assert.strictEqual(ds.supportsBalance, true);
    assert.strictEqual(plat.data.platforms.length, CATALOG.platforms.length, '平台目录数据驱动加载');
    assert.strictEqual(plat.data.platforms.find(p => p.id === 'moonshot').supportsBalance, true);
    assert.strictEqual(plat.data.platforms.find(p => p.id === 'siliconflow').supportsBalance, true);
    assert.strictEqual(plat.data.platforms.find(p => p.id === 'openai').supportsBalance, false);

    const idxRes = await fetch(base + '/');
    assert.strictEqual(idxRes.status, 200);
    const idxText = await idxRes.text();
    assert.ok(idxText.includes('AI Key Manager'), '首页应可访问');

    let r = await call(base, 'POST', '/api/keys', {
      platform: 'deepseek',
      key: 'sk-1234567890abcdef',
      name: ''
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const k = r.data.key;
    assert.strictEqual(k.name, 'DeepSeek-cdef', '名称留空自动生成');
    assert.strictEqual(k.balance.status, 'pending');

    r = await call(base, 'POST', '/api/keys', {
      platform: 'deepseek',
      key: 'sk-another-key-9999',
      name: 'DeepSeek-cdef'
    });
    assert.strictEqual(r.status, 409, '同平台重名应被拒绝');

    r = await call(base, 'POST', '/api/keys', { platform: 'deepseek', key: '' });
    assert.strictEqual(r.status, 400, '缺少 Key 应被拒绝');

    r = await call(base, 'POST', '/api/keys', {
      platform: 'openai', key: 'sk-openai-xyz-1234'
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.data.key.balance.status, 'unsupported', 'OpenAI 不支持余额查询');
    const openaiId = r.data.key.id;

    r = await call(base, 'POST', '/api/keys/' + k.id + '/test');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.test.status, 'pass');
    assert.ok(r.data.test.latency >= 0);

    r = await call(base, 'POST', '/api/keys/' + k.id + '/models/fetch');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.models.length, 2);
    const chat = r.data.models.find(m => m.id === 'deepseek-chat');
    assert.strictEqual(chat.ctx, 65536, '元数据库应补齐上下文');
    assert.strictEqual(chat.src, 'meta');

    r = await call(base, 'POST', '/api/keys/' + k.id + '/models', {
      id: 'my-model', ctx: 1000, out: 200, note: 'Dify'
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.models.length, 3);

    r = await call(base, 'POST', '/api/keys/' + k.id + '/models/fetch');
    const mine = r.data.models.find(m => m.id === 'my-model');
    assert.ok(mine, '重新拉取后手动模型保留');
    assert.strictEqual(mine.note, 'Dify');
    assert.strictEqual(mine.ctx, 1000);

    r = await call(base, 'PATCH', '/api/keys/' + k.id + '/models/my-model', { note: 'n8n' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.models.find(m => m.id === 'my-model').note, 'n8n');

    r = await call(base, 'PUT', '/api/keys/' + k.id, { model: 'my-model' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.key.model, 'my-model');

    r = await call(base, 'POST', '/api/keys/' + k.id + '/assigned', { tool: 'Dify' });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.data.assigned, ['Dify']);
    r = await call(base, 'POST', '/api/keys/' + k.id + '/assigned', { tool: 'Dify' });
    assert.strictEqual(r.status, 409, '重复添加去向应被拒绝');
    r = await call(base, 'DELETE', '/api/keys/' + k.id + '/assigned/' + encodeURIComponent('Dify'));
    assert.deepStrictEqual(r.data.assigned, []);

    r = await call(base, 'POST', '/api/refresh-balances');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.updated, 1, '仅 DeepSeek 支持余额查询');
    const dsKey = r.data.keys.find(x => x.platform === 'deepseek');
    assert.strictEqual(dsKey.balance.value, 88.5);
    assert.strictEqual(dsKey.balance.status, 'ok');

    r = await call(base, 'DELETE', '/api/keys/' + openaiId);
    assert.strictEqual(r.status, 200);
    r = await call(base, 'GET', '/api/keys');
    assert.strictEqual(r.data.keys.length, 1);

    r = await call(base, 'GET', '/api/keys/9999');
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test('API 集成：401 密钥在测试与拉取时给出失败结果', async () => {
  const { server, base } = await startServer(mockFetch401);
  try {
    let r = await call(base, 'POST', '/api/keys', {
      platform: 'deepseek', key: 'sk-bad-key-0000'
    });
    const id = r.data.key.id;

    r = await call(base, 'POST', '/api/keys/' + id + '/test');
    assert.strictEqual(r.data.test.status, 'fail');
    assert.strictEqual(r.data.test.code, '401');

    r = await call(base, 'POST', '/api/keys/' + id + '/models/fetch');
    assert.strictEqual(r.status, 502);
    assert.ok(r.data.error.includes('401'));

    r = await call(base, 'POST', '/api/refresh-balances');
    const k = r.data.keys.find(x => x.platform === 'deepseek');
    assert.strictEqual(k.balance.status, 'fail');
  } finally {
    server.close();
  }
});

test('API 安全：拒绝跨域写请求', async () => {
  const { server, base } = await startServer(mockFetch);
  try {
    const r = await call(base, 'POST', '/api/keys',
      { platform: 'deepseek', key: 'sk-x-1234' },
      { Origin: 'http://evil.example.com' });
    assert.strictEqual(r.status, 403);

    const host = new URL(base).host;
    const ok = await call(base, 'POST', '/api/keys',
      { platform: 'deepseek', key: 'sk-x-1234' },
      { Origin: 'http://' + host });
    assert.strictEqual(ok.status, 201, '同源写请求应放行');
  } finally {
    server.close();
  }
});

test('API 集成：endpoints 数组的创建、校验与更新', async () => {
  const { server, base } = await startServer(mockFetch);
  try {
    let r = await call(base, 'POST', '/api/keys', {
      platform: 'deepseek',
      key: 'sk-multi-ep-0001',
      endpoints: [
        { url: 'https://api.deepseek.com', style: 'openai' },
        { url: 'https://api.deepseek.com/anthropic', style: 'anthropic' }
      ]
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const id = r.data.key.id;
    assert.deepStrictEqual(r.data.key.endpoints, [
      { url: 'https://api.deepseek.com', style: 'openai' },
      { url: 'https://api.deepseek.com/anthropic', style: 'anthropic' }
    ]);

    r = await call(base, 'POST', '/api/keys', {
      platform: 'deepseek', key: 'sk-legacy-base-0002', base: 'https://api.deepseek.com'
    });
    assert.strictEqual(r.status, 201, '旧版 base 字段应仍可用');
    assert.deepStrictEqual(r.data.key.endpoints, [{ url: 'https://api.deepseek.com', style: 'openai' }]);

    r = await call(base, 'POST', '/api/keys', {
      platform: 'deepseek', key: 'sk-default-ep-0003'
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.data.key.endpoints.length, 2, '未传地址时用平台默认端点');

    r = await call(base, 'POST', '/api/keys', {
      platform: 'deepseek', key: 'sk-too-many-0004',
      endpoints: new Array(7).fill({ url: 'https://x.example.com' })
    });
    assert.strictEqual(r.status, 400);
    assert.ok(r.data.error.includes('6'));

    r = await call(base, 'POST', '/api/keys', {
      platform: 'deepseek', key: 'sk-bad-ep-0005', endpoints: 'not-array'
    });
    assert.strictEqual(r.status, 400);

    r = await call(base, 'PUT', '/api/keys/' + id, {
      endpoints: [{ url: 'https://gw.example.com', style: 'gemini 兼容' }]
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.key.endpoints, [{ url: 'https://gw.example.com', style: 'gemini 兼容' }]);

    r = await call(base, 'PUT', '/api/keys/' + id, { name: '改名不动端点' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.key.endpoints.length, 1, '普通更新不应清空端点');
  } finally {
    server.close();
  }
});

test('API 集成：测试与拉取使用首个端点', async () => {
  const urls = [];
  const f = (url) => {
    urls.push(String(url));
    return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 }));
  };
  const { server, base } = await startServer(f);
  try {
    let r = await call(base, 'POST', '/api/keys', {
      platform: 'deepseek',
      key: 'sk-primary-ep-0006',
      endpoints: [
        { url: 'https://primary.example.com', style: 'openai' },
        { url: 'https://second.example.com', style: 'anthropic' }
      ]
    });
    const id = r.data.key.id;

    r = await call(base, 'POST', '/api/keys/' + id + '/test');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.test.status, 'pass');
    assert.ok(urls[0].startsWith('https://primary.example.com/models'), '测试应请求首个端点');

    r = await call(base, 'POST', '/api/keys/' + id + '/models/fetch');
    assert.strictEqual(r.status, 200);
    assert.ok(urls[1].startsWith('https://primary.example.com/models'), '拉取应请求首个端点');
  } finally {
    server.close();
  }
});

test('API 集成：无 /models 端点时测试回退鉴权探测（火山方舟 Agent Plan）', async () => {
  const f = (url) => {
    const u = String(url);
    if (u.includes('/models')) return Promise.resolve(new Response('', { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify({
      error: { code: 'UnsupportedModel', message: 'The requested model does not support the agent plan feature' }
    }), { status: 404 }));
  };
  const { server, base } = await startServer(f);
  try {
    let r = await call(base, 'POST', '/api/keys', {
      platform: 'custom', customName: '中转网关', key: 'sk-gw-404-0002',
      endpoints: [{ url: 'https://gw.example.com/v1', style: 'openai' }]
    });
    const id = r.data.key.id;

    r = await call(base, 'POST', '/api/keys/' + id + '/test');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.test.status, 'pass', JSON.stringify(r.data.test));
    assert.ok(r.data.test.msg.includes('chat/completions'), '通过消息应说明回退探测方式');

    r = await call(base, 'POST', '/api/keys/' + id + '/models/fetch');
    assert.strictEqual(r.status, 502);
    assert.ok(r.data.error.includes('手动添加模型'), '拉取失败应引导手动添加模型');
  } finally {
    server.close();
  }
});

test('API 集成：方舟 Agent Plan 拉取模型返回官方内置目录', async () => {
  const f = (url) => String(url).includes('/models')
    ? Promise.resolve(new Response('', { status: 404 }))
    : Promise.resolve(new Response(JSON.stringify({ error: { code: 'UnsupportedModel' } }), { status: 404 }));
  const { server, base } = await startServer(f);
  try {
    let r = await call(base, 'POST', '/api/keys', {
      platform: 'custom', customName: '火山方舟', key: 'sk-ark-plan-0001',
      endpoints: [{ url: 'https://ark.cn-beijing.volces.com/api/plan/v3', style: 'openai' }]
    });
    const id = r.data.key.id;

    r = await call(base, 'POST', '/api/keys/' + id + '/test');
    assert.strictEqual(r.data.test.status, 'pass');
    assert.ok(r.data.test.msg.includes('Agent Plan'), '测试消息应说明内置目录判定');

    r = await call(base, 'POST', '/api/keys/' + id + '/models/fetch');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.models.length >= 15, '应返回内置模型目录');
    const ds = r.data.models.find(m => m.id === 'deepseek-v4-flash');
    assert.strictEqual(ds.ctx, 1048576);
    assert.strictEqual(ds.src, 'builtin');
    const fetchedCount = r.data.models.length;

    r = await call(base, 'GET', '/api/keys');
    const saved = r.data.keys.find(k => k.id === id);
    assert.strictEqual(saved.modelsFetched, true);
    assert.strictEqual(saved.models.length, fetchedCount, '内置目录应已入库');
  } finally {
    server.close();
  }
});

test('API 集成：余额按端点域名匹配（自定义平台与多端点回退）', async () => {
  const urls = [];
  const f = (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/user/balance')) {
      return Promise.resolve(new Response(JSON.stringify({
        balance_infos: [{ currency: 'CNY', total_balance: '66.60' }]
      }), { status: 200 }));
    }
    if (u.includes('/v1/users/me/balance')) {
      return Promise.resolve(new Response(JSON.stringify({
        data: { available_balance: '12.34' }
      }), { status: 200 }));
    }
    if (u.includes('/v1/user/info')) {
      return Promise.resolve(new Response(JSON.stringify({
        data: { totalBalance: '56.78' }
      }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  };
  const { server, base } = await startServer(f);
  try {
    let r = await call(base, 'POST', '/api/keys', {
      platform: 'custom', customName: 'DS 中转', key: 'sk-custom-ds-001',
      endpoints: [{ url: 'https://api.deepseek.com', style: 'openai' }]
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.data.key.balance.status, 'pending', '自定义平台命中已知域名应为待查询');

    r = await call(base, 'POST', '/api/keys', { platform: 'moonshot', key: 'sk-ms-000000001' });
    const msId = r.data.key.id;
    assert.strictEqual(r.data.key.balance.status, 'pending');
    r = await call(base, 'POST', '/api/keys', { platform: 'siliconflow', key: 'sk-sf-000000002' });
    const sfId = r.data.key.id;
    assert.strictEqual(r.data.key.balance.status, 'pending');

    r = await call(base, 'POST', '/api/keys', {
      platform: 'deepseek', key: 'sk-multi-ep-0007',
      endpoints: [
        { url: 'https://gw.example.com/v1', style: 'openai' },
        { url: 'https://api.deepseek.com', style: 'openai' }
      ]
    });
    const multiId = r.data.key.id;
    assert.strictEqual(r.data.key.balance.status, 'pending');

    r = await call(base, 'POST', '/api/refresh-balances');
    assert.strictEqual(r.data.updated, 4, '命中已知域名的四个密钥都应更新');
    assert.strictEqual(r.data.failed, 0);
    assert.strictEqual(urls.filter(u => u.includes('/user/balance')).length, 2, '网关端点不应发起余额请求');
    const byId = {};
    r.data.keys.forEach(k => { byId[k.id] = k; });
    assert.strictEqual(byId[multiId].balance.value, 66.6);
    assert.strictEqual(byId[multiId].balance.status, 'ok');
    assert.strictEqual(byId[msId].balance.value, 12.34, 'Moonshot 余额解析');
    assert.strictEqual(byId[sfId].balance.value, 56.78, 'SiliconFlow 余额解析');
    const customKey = r.data.keys.find(k => k.platform === 'custom');
    assert.strictEqual(customKey.balance.value, 66.6, '自定义平台指向官方域名同样可查');

    r = await call(base, 'PUT', '/api/keys/' + multiId, {
      endpoints: [{ url: 'https://other.example.com/v1', style: 'openai' }]
    });
    assert.strictEqual(r.data.key.balance.status, 'unsupported', '端点改离官方域名应重置为不支持');
    assert.strictEqual(r.data.key.balance.value, null);

    r = await call(base, 'PUT', '/api/keys/' + multiId, {
      endpoints: [{ url: 'https://api.deepseek.com', style: 'openai' }]
    });
    assert.strictEqual(r.data.key.balance.status, 'pending', '端点改回官方域名应重置为待查询');

    r = await call(base, 'POST', '/api/refresh-balances');
    r = await call(base, 'PUT', '/api/keys/' + multiId, {
      endpoints: [
        { url: 'https://api.deepseek.com', style: 'openai' },
        { url: 'https://api.deepseek.com/anthropic', style: 'anthropic' }
      ]
    });
    assert.strictEqual(r.data.key.balance.status, 'ok', '支持状态未变时应保留余额');
    assert.strictEqual(r.data.key.balance.value, 66.6);
  } finally {
    server.close();
  }
});

test('API 校验：非法请求体与非 JSON', async () => {
  const { server, base } = await startServer(mockFetch);
  try {
    const r = await fetch(base + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{'
    });
    assert.strictEqual(r.status, 400);

    const unknown = await call(base, 'POST', '/api/keys', { platform: 'notexist', key: 'sk-1' });
    assert.strictEqual(unknown.status, 400);
  } finally {
    server.close();
  }
});
