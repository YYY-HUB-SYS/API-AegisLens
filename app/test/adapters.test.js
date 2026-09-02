const { test } = require('node:test');
const assert = require('node:assert');
const adapters = require('../src/adapters');

function res(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200 });
}

test('fetchModels：OpenAI 风格响应解析 + 元数据库补参数', async () => {
  let captured = null;
  const f = (url, opts) => {
    captured = { url, headers: opts.headers };
    return Promise.resolve(res({ data: [{ id: 'deepseek-chat' }, { id: 'unknown-model' }] }));
  };
  const ep = { url: 'https://api.deepseek.com/', style: 'openai' };
  const models = await adapters.fetchModels('deepseek', ep, 'sk-test', { fetchImpl: f });
  assert.strictEqual(captured.url, 'https://api.deepseek.com/models', '末尾斜杠应被去除');
  assert.strictEqual(captured.headers['Authorization'], 'Bearer sk-test');
  assert.strictEqual(models.length, 2);

  const known = models.find(m => m.id === 'deepseek-chat');
  assert.strictEqual(known.ctx, 65536);
  assert.strictEqual(known.out, 8192);
  assert.strictEqual(known.src, 'meta');

  const unknown = models.find(m => m.id === 'unknown-model');
  assert.strictEqual(unknown.ctx, null);
  assert.strictEqual(unknown.src, 'api');
});

test('fetchModels：Anthropic 使用 x-api-key 头与 /v1/models 路径', async () => {
  let captured = null;
  const f = (url, opts) => {
    captured = { url, headers: opts.headers };
    return Promise.resolve(res({ data: [{ id: 'claude-sonnet-4-5' }] }));
  };
  const models = await adapters.fetchModels('anthropic', { url: 'https://api.anthropic.com', style: 'anthropic' }, 'sk-ant-test', { fetchImpl: f });
  assert.strictEqual(captured.url, 'https://api.anthropic.com/v1/models');
  assert.strictEqual(captured.headers['x-api-key'], 'sk-ant-test');
  assert.strictEqual(captured.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(models[0].ctx, 200000);
  assert.strictEqual(models[0].out, 64000);
});

test('fetchModels：DeepSeek Anthropic 兼容端点按 anthropic 风格请求', async () => {
  let captured = null;
  const f = (url, opts) => {
    captured = { url, headers: opts.headers };
    return Promise.resolve(res({ data: [{ id: 'deepseek-chat' }] }));
  };
  await adapters.fetchModels('deepseek', { url: 'https://api.deepseek.com/anthropic', style: 'anthropic' }, 'sk-x', { fetchImpl: f });
  assert.strictEqual(captured.url, 'https://api.deepseek.com/anthropic/v1/models');
  assert.strictEqual(captured.headers['x-api-key'], 'sk-x');
});

test('fetchModels：自定义兼容模式拒绝自动拉取', async () => {
  await assert.rejects(
    () => adapters.fetchModels('custom', { url: 'https://gw.example.com', style: 'gemini' }, 'sk-x', { fetchImpl: async () => res({}) }),
    /自定义兼容模式/
  );
});

test('fetchModels：无 Base URL 时给出明确错误', async () => {
  await assert.rejects(
    () => adapters.fetchModels('custom', { url: '', style: 'openai' }, 'sk-x', {}),
    /Base URL/
  );
});

test('fetchModels：401 归类为密钥无效', async () => {
  const f = () => Promise.resolve(res({ error: 'bad key' }, 401));
  await assert.rejects(
    () => adapters.fetchModels('openai', { url: 'https://api.openai.com/v1', style: 'openai' }, 'sk-bad', { fetchImpl: f }),
    /401/
  );
});

test('fetchModels：404 提示检查 Base URL', async () => {
  const f = () => Promise.resolve(res({}, 404));
  await assert.rejects(
    () => adapters.fetchModels('custom', { url: 'https://wrong.example.com', style: 'openai' }, 'sk-x', { fetchImpl: f }),
    /Base URL/
  );
});

test('fetchModels：超时中断', async () => {
  const f = (url, opts) => new Promise((_, rej) => {
    opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
  });
  await assert.rejects(
    () => adapters.fetchModels('deepseek', { url: 'https://api.deepseek.com', style: 'openai' }, 'sk-x', { fetchImpl: f, timeoutMs: 60 }),
    /超时/
  );
});

test('fetchBalance：DeepSeek 余额解析（CNY）', async () => {
  let captured = null;
  const f = (url, opts) => {
    captured = { url, headers: opts.headers };
    return Promise.resolve(res({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.50' },
        { currency: 'USD', total_balance: '0.00' }
      ]
    }));
  };
  const bal = await adapters.fetchBalance('deepseek', { url: 'https://api.deepseek.com', style: 'openai' }, 'sk-test', { fetchImpl: f });
  assert.strictEqual(captured.url, 'https://api.deepseek.com/user/balance');
  assert.strictEqual(bal.value, 110.5);
  assert.strictEqual(bal.status, 'ok');
});

test('fetchBalance：非 DeepSeek 平台返回 null（不支持）', async () => {
  const bal = await adapters.fetchBalance('openai', { url: 'https://api.openai.com/v1', style: 'openai' }, 'sk-x', { fetchImpl: async () => res({}) });
  assert.strictEqual(bal, null);
});

test('testKey：通过 / 失败场景', async () => {
  const ok = await adapters.testKey('deepseek', { url: 'https://api.deepseek.com', style: 'openai' }, 'sk-x', {
    fetchImpl: () => Promise.resolve(res({ data: [{ id: 'deepseek-chat' }] }))
  });
  assert.strictEqual(ok.status, 'pass');
  assert.ok(ok.latency >= 0);

  const fail401 = await adapters.testKey('deepseek', { url: 'https://api.deepseek.com', style: 'openai' }, 'sk-bad', {
    fetchImpl: () => Promise.resolve(res({}, 401))
  });
  assert.strictEqual(fail401.status, 'fail');
  assert.strictEqual(fail401.code, '401');

  const noBase = await adapters.testKey('custom', { url: '', style: 'openai' }, 'sk-x', {});
  assert.strictEqual(noBase.status, 'fail');
  assert.strictEqual(noBase.code, 'NO_BASE');

  const customStyle = await adapters.testKey('custom', { url: 'https://gw.example.com', style: 'my-style' }, 'sk-x', {});
  assert.strictEqual(customStyle.status, 'fail');
  assert.strictEqual(customStyle.code, 'UNSUPPORTED_STYLE');
});

test('testKey：/models 404 时回退 chat/completions 鉴权探测（无列表接口的兼容端点）', async () => {
  const calls = [];
  const f = (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body });
    if (u.endsWith('/models')) return Promise.resolve(res({}, 404));
    return Promise.resolve(res({
      error: { code: 'UnsupportedModel', message: 'The requested model does not support the agent plan feature' }
    }, 404));
  };
  const t = await adapters.testKey('custom', { url: 'https://gw.example.com/v1', style: 'openai' }, 'sk-ark', { fetchImpl: f });
  assert.strictEqual(t.status, 'pass', JSON.stringify(t));
  assert.ok(t.msg.includes('chat/completions'));
  assert.strictEqual(calls.length, 2, '应先 GET /models 再 POST 对话接口');
  assert.strictEqual(calls[0].method, 'GET');
  assert.strictEqual(calls[1].method, 'POST');
  assert.ok(calls[1].url.endsWith('/chat/completions'));
  assert.ok(calls[1].body.includes('"max_tokens":1'), '探测请求限制 1 token');
});

test('testKey：/models 404 且探测返回 401 时判定密钥无效', async () => {
  const f = (url) => String(url).endsWith('/models')
    ? Promise.resolve(res({}, 404))
    : Promise.resolve(res({ error: { message: 'the API key is missing or invalid' } }, 401));
  const t = await adapters.testKey('custom', { url: 'https://x.example.com/v1', style: 'openai' }, 'sk-bad', { fetchImpl: f });
  assert.strictEqual(t.status, 'fail');
  assert.strictEqual(t.code, '401');
  assert.ok(t.msg.includes('密钥无效'));
});

test('testKey：/models 404 且探测 404 无模型特征时仍报地址错误', async () => {
  const f = () => Promise.resolve(res({ error: { message: 'Invalid URL (POST /chat/completions)' } }, 404));
  const t = await adapters.testKey('custom', { url: 'https://api.example.com', style: 'openai' }, 'sk-x', { fetchImpl: f });
  assert.strictEqual(t.status, 'fail');
  assert.strictEqual(t.code, '404');
  assert.ok(t.msg.includes('Base URL'));
});

test('testKey：anthropic 风格 /v1/models 404 时回退 /v1/messages 探测', async () => {
  const f = (url) => String(url).endsWith('/v1/models')
    ? Promise.resolve(res({}, 404))
    : Promise.resolve(res({ type: 'error', error: { type: 'not_found_error', message: 'model: __key_probe__ not found' } }, 404));
  const t = await adapters.testKey('custom', { url: 'https://gw.example.com', style: 'anthropic' }, 'sk-x', { fetchImpl: f });
  assert.strictEqual(t.status, 'pass', JSON.stringify(t));
  assert.ok(t.msg.includes('/v1/messages'));
});

test('fetchModels：火山方舟 Agent Plan 端点返回官方内置模型目录', async () => {
  const f = () => Promise.resolve(res({}, 404));
  const models = await adapters.fetchModels('custom',
    { url: 'https://ark.cn-beijing.volces.com/api/plan/v3', style: 'openai' }, 'sk-ark', { fetchImpl: f });
  assert.ok(models.length >= 15, '内置目录应包含完整模型列表');
  const ds = models.find(m => m.id === 'deepseek-v4-flash');
  assert.strictEqual(ds.ctx, 1048576);
  assert.strictEqual(ds.out, 393216);
  assert.strictEqual(ds.src, 'builtin');
  const auto = models.find(m => m.id === 'auto');
  assert.ok(auto, '内置目录应含 Auto 智能路由模型');
  assert.ok(models.some(m => m.id === 'ark-code-latest'), '内置目录应含编程模型');
});

test('fetchModels：非方舟端点 404 不落入内置目录', async () => {
  const f = () => Promise.resolve(res({}, 404));
  await assert.rejects(
    () => adapters.fetchModels('custom', { url: 'https://ark.cn-beijing.volces.com/api/v3', style: 'openai' }, 'sk-x', { fetchImpl: f }),
    /手动添加模型/
  );
});

test('testKey：方舟 Agent Plan 端点经内置目录判定密钥可用', async () => {
  const f = () => Promise.resolve(res({}, 404));
  const t = await adapters.testKey('custom',
    { url: 'https://ark.cn-beijing.volces.com/api/plan/v3', style: 'openai' }, 'sk-ark', { fetchImpl: f });
  assert.strictEqual(t.status, 'pass', JSON.stringify(t));
  assert.ok(t.msg.includes('Agent Plan'), JSON.stringify(t));
});

test('fetchModels：请求带编程工具 UA（通过中转站客户端指纹检测）', async () => {
  let captured = null;
  const f = (url, opts) => {
    captured = { url, headers: opts.headers };
    return Promise.resolve(res({ data: [{ id: 'claude-opus-5' }] }));
  };
  const models = await adapters.fetchModels('custom', { url: 'https://agentrouter.org', style: 'anthropic' }, 'sk-ar', { fetchImpl: f });
  assert.strictEqual(models.length, 1);
  assert.ok(captured.headers['User-Agent'] && captured.headers['User-Agent'].startsWith('claude-cli/'),
    '两种风格请求都应带工具 UA: ' + JSON.stringify(captured.headers));
  assert.strictEqual(captured.headers['x-api-key'], 'sk-ar');

  await adapters.fetchModels('custom', { url: 'https://agentrouter.org', style: 'openai' }, 'sk-ar', { fetchImpl: f });
  assert.strictEqual(captured.headers['Authorization'], 'Bearer sk-ar');
  assert.ok(captured.headers['User-Agent'].startsWith('claude-cli/'));
});

test('normalizeEndpoints：默认端点、上限与过滤', () => {
  const def = adapters.normalizeEndpoints('deepseek', undefined);
  assert.deepStrictEqual(def, [
    { url: 'https://api.deepseek.com', style: 'openai' },
    { url: 'https://api.deepseek.com/anthropic', style: 'anthropic' }
  ]);

  assert.deepStrictEqual(adapters.normalizeEndpoints('custom', null), [], '自定义平台默认无端点');

  const kept = adapters.normalizeEndpoints('custom', [
    { url: 'https://a.example.com', style: 'openai' },
    { url: '', style: 'anthropic' },
    { url: 'https://b.example.com' }
  ]);
  assert.deepStrictEqual(kept, [
    { url: 'https://a.example.com', style: 'openai' },
    { url: 'https://b.example.com', style: 'openai' }
  ], '空 URL 被过滤，缺省 style 按平台推断');

  assert.throws(() => adapters.normalizeEndpoints('custom', new Array(7).fill({ url: 'https://x.com' })), /最多支持 6 个/);
  assert.throws(() => adapters.normalizeEndpoints('custom', 'not-array'), /数组/);
  assert.throws(() => adapters.normalizeEndpoints('custom', [{ url: 'https://x.com', style: 'a'.repeat(31) }]), /兼容模式名称过长/);

  const customStyle = adapters.normalizeEndpoints('custom', [{ url: 'https://gw.example.com', style: 'gemini 兼容' }]);
  assert.deepStrictEqual(customStyle, [{ url: 'https://gw.example.com', style: 'gemini 兼容' }]);
});

test('primaryEndpoint：取首个端点并兼容旧 base 字段', () => {
  const eps = [{ url: 'https://a.com', style: 'openai' }, { url: 'https://b.com', style: 'anthropic' }];
  assert.deepStrictEqual(adapters.primaryEndpoint({ platform: 'deepseek', endpoints: eps }), eps[0]);
  assert.deepStrictEqual(
    adapters.primaryEndpoint({ platform: 'anthropic', base: 'https://api.anthropic.com' }),
    { url: 'https://api.anthropic.com', style: 'anthropic' }
  );
  assert.deepStrictEqual(
    adapters.primaryEndpoint({ platform: 'openai', base: 'https://api.openai.com/v1' }),
    { url: 'https://api.openai.com/v1', style: 'openai' }
  );
  assert.deepStrictEqual(
    adapters.primaryEndpoint({ platform: 'custom', endpoints: [] }),
    { url: '', style: 'openai' }
  );
});

test('lookupMeta：精确匹配与通配符匹配', () => {
  assert.strictEqual(adapters.lookupMeta('openai', 'gpt-4o').ctx, 128000);
  assert.strictEqual(adapters.lookupMeta('openai', 'gpt-4o-2024-08-06').ctx, 128000);
  assert.strictEqual(adapters.lookupMeta('deepseek', 'nope'), null);
});

test('mergeModels：保留手动模型参数与备注，追加仅手动添加的模型', () => {
  const prev = [
    { id: 'deepseek-chat', ctx: null, out: null, src: 'meta', note: 'Dify · 客服' },
    { id: 'my-model', ctx: 999, out: 111, src: 'manual', note: 'n8n' }
  ];
  const fetched = [
    { id: 'deepseek-chat', ctx: 65536, out: 8192, src: 'meta', note: null },
    { id: 'deepseek-reasoner', ctx: 65536, out: 8192, src: 'meta', note: null }
  ];
  const merged = adapters.mergeModels(prev, fetched);
  assert.strictEqual(merged.length, 3);

  const chat = merged.find(m => m.id === 'deepseek-chat');
  assert.strictEqual(chat.ctx, 65536);
  assert.strictEqual(chat.note, 'Dify · 客服', '拉取不应丢失备注');

  const mine = merged.find(m => m.id === 'my-model');
  assert.ok(mine, '手动添加的模型应保留');
  assert.strictEqual(mine.src, 'manual');
  assert.strictEqual(mine.ctx, 999);
});
