const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');

function mockFetch(url, opts) {
  const u = String(url);
  if (u.includes('/user/balance')) {
    return Promise.resolve(new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '88.50' }]
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
    assert.strictEqual(plat.data.platforms.length, 5);

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
      platform: 'custom', customName: '火山方舟', key: 'sk-ark-plan-0001',
      endpoints: [{ url: 'https://ark.cn-beijing.volces.com/api/plan/v3', style: 'openai' }]
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
