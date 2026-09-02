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
  const models = await adapters.fetchModels('deepseek', 'sk-test', 'https://api.deepseek.com/', { fetchImpl: f });
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
  const models = await adapters.fetchModels('anthropic', 'sk-ant-test', 'https://api.anthropic.com', { fetchImpl: f });
  assert.strictEqual(captured.url, 'https://api.anthropic.com/v1/models');
  assert.strictEqual(captured.headers['x-api-key'], 'sk-ant-test');
  assert.strictEqual(captured.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(models[0].ctx, 200000);
  assert.strictEqual(models[0].out, 64000);
});

test('fetchModels：无 Base URL 时给出明确错误', async () => {
  await assert.rejects(
    () => adapters.fetchModels('custom', 'sk-x', '', {}),
    /Base URL/
  );
});

test('fetchModels：401 归类为密钥无效', async () => {
  const f = () => Promise.resolve(res({ error: 'bad key' }, 401));
  await assert.rejects(
    () => adapters.fetchModels('openai', 'sk-bad', 'https://api.openai.com/v1', { fetchImpl: f }),
    /401/
  );
});

test('fetchModels：404 提示检查 Base URL', async () => {
  const f = () => Promise.resolve(res({}, 404));
  await assert.rejects(
    () => adapters.fetchModels('custom', 'sk-x', 'https://wrong.example.com', { fetchImpl: f }),
    /Base URL/
  );
});

test('fetchModels：超时中断', async () => {
  const f = (url, opts) => new Promise((_, rej) => {
    opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
  });
  await assert.rejects(
    () => adapters.fetchModels('deepseek', 'sk-x', 'https://api.deepseek.com', { fetchImpl: f, timeoutMs: 60 }),
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
  const bal = await adapters.fetchBalance('deepseek', 'sk-test', 'https://api.deepseek.com', { fetchImpl: f });
  assert.strictEqual(captured.url, 'https://api.deepseek.com/user/balance');
  assert.strictEqual(bal.value, 110.5);
  assert.strictEqual(bal.status, 'ok');
});

test('fetchBalance：非 DeepSeek 平台返回 null（不支持）', async () => {
  const bal = await adapters.fetchBalance('openai', 'sk-x', 'https://api.openai.com/v1', { fetchImpl: async () => res({}) });
  assert.strictEqual(bal, null);
});

test('testKey：通过 / 失败场景', async () => {
  const ok = await adapters.testKey('deepseek', 'sk-x', 'https://api.deepseek.com', {
    fetchImpl: () => Promise.resolve(res({ data: [{ id: 'deepseek-chat' }] }))
  });
  assert.strictEqual(ok.status, 'pass');
  assert.ok(ok.latency >= 0);

  const fail401 = await adapters.testKey('deepseek', 'sk-bad', 'https://api.deepseek.com', {
    fetchImpl: () => Promise.resolve(res({}, 401))
  });
  assert.strictEqual(fail401.status, 'fail');
  assert.strictEqual(fail401.code, '401');

  const noBase = await adapters.testKey('custom', 'sk-x', '', {});
  assert.strictEqual(noBase.status, 'fail');
  assert.strictEqual(noBase.code, 'NO_BASE');
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
