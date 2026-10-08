/* 写入侧的两条守门规则。
   一、ctx/out 进库必须是正整数或 null：/api/import 把用户 JSON 原样递进来，
       SQLite 的 INTEGER 亲和性会把 '1e5' 悄悄变成 100000、却把 'abc' 留在列里，
       JSON 后端则一概不动 —— 不归一的话同一条数据在两个后端连类型都不一样。
   二、人手改过的数值必须把按字段来源一起改成 manual，否则库里会留着拉取时的 'api'。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');

function fresh(backend) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-normalize-'));
  const store = createStore(dir, loadOrCreateMasterKey(dir), { backend: backend });
  const k = store.createKey({
    platform: 'deepseek', name: 'probe', key: 'sk-probe-0001',
    endpoints: [{ url: 'https://api.deepseek.com', style: 'openai' }]
  });
  return { store: store, id: k.id };
}

const ODD = [
  ['1e5', 100000],       // 科学计数法字符串：两个后端都得是同一个数
  [' 12000 ', 12000],    // 带空白
  ['abc', null],         // 非数值：SQLite 原本会把它塞进 INTEGER 列
  ['', null],
  ['-1', null],
  ['1.5', null],         // 分数 token 不是 token 数
  [true, null],
  [[65536], null],
  [{ v: 1 }, null]
];

['sqlite', 'json'].forEach(function (backend) {
  ODD.forEach(function (c) {
    test(backend + ' 后端：upsertModel 收到 ' + JSON.stringify(c[0]) + ' 时 ctx 归一为 ' + c[1], () => {
      const k = fresh(backend);
      k.store.upsertModel(k.id, { id: 'm', ctx: c[0], out: c[0], src: 'api' });
      const m = k.store.getKey(k.id).models.find(x => x.id === 'm');
      assert.strictEqual(m.ctx, c[1]);
      assert.strictEqual(m.out, c[1]);
      assert.strictEqual(typeof m.ctx, c[1] === null ? 'object' : 'number');
    });
  });

  test(backend + ' 后端：replaceModels 同样归一，且不会改写调用方传入的对象', () => {
    const k = fresh(backend);
    const incoming = [{ id: 'm', ctx: '65536', out: 8192, src: 'api' }];
    k.store.replaceModels(k.id, incoming);
    assert.strictEqual(k.store.getKey(k.id).models[0].ctx, 65536);
    assert.strictEqual(incoming[0].ctx, '65536', '归一只能发生在写入侧，不能顺手改了别人的对象');
  });

  test(backend + ' 后端：undefined 表示本次不动，null 表示确认清空', () => {
    const k = fresh(backend);
    k.store.upsertModel(k.id, { id: 'm', ctx: 32768, out: 4096, src: 'api' });
    k.store.upsertModel(k.id, { id: 'm', out: 'abc' });
    let m = k.store.getKey(k.id).models.find(x => x.id === 'm');
    assert.strictEqual(m.ctx, 32768, '补丁没带 ctx，原值必须还在');
    assert.strictEqual(m.out, null, '带了但归一不成数值，按清空处理');
    k.store.upsertModel(k.id, { id: 'm', ctx: null });
    m = k.store.getKey(k.id).models.find(x => x.id === 'm');
    assert.strictEqual(m.ctx, null, '显式 null 是清空，不是忽略');
    assert.strictEqual(m.out, null);
  });
});

/* 两个后端对同一份输入必须给出一模一样的行 —— 类型也一样。 */
test('sqlite 与 json 后端对同一批写入给出完全一致的行', () => {
  const inputs = [{ id: 'm', ctx: '1e5', out: 'abc', src: 'api', ctxSrc: 'api', outSrc: 'web' }];
  const read = (backend) => {
    const k = fresh(backend);
    k.store.replaceModels(k.id, inputs);
    const m = k.store.getKey(k.id).models[0];
    return { ctx: m.ctx, out: m.out, ctxSrc: m.ctxSrc, outSrc: m.outSrc };
  };
  const a = read('sqlite');
  const b = read('json');
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, { ctx: 100000, out: null, ctxSrc: 'api', outSrc: 'web' });
});

async function startServer(fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-src-probe-'));
  const server = createApp({
    storage: createStore(dir, loadOrCreateMasterKey(dir), { backend: 'json' }),
    fetchImpl: fetchImpl,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test'
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server: server, base: 'http://127.0.0.1:' + server.address().port };
}

function call(base, method, p, body) {
  return fetch(base + p, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(res => res.json().then(data => ({ status: res.status, data: data })));
}

/* 模型 ID 故意取成元数据库里查不到的样子，免得 meta/web 补齐干扰来源断言。 */
const SOURCED_FETCH = () => Promise.resolve(new Response(JSON.stringify({
  data: [{ id: 'probe-model', context_length: 128000, max_output_tokens: 8192 }]
}), { status: 200 }));

test('API：PATCH 只改 ctx 时，ctxSrc 变 manual 而 outSrc 保留 api', async () => {
  const { server, base } = await startServer(SOURCED_FETCH);
  try {
    let r = await call(base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-probe-src-0001' });
    const id = r.data.key.id;

    r = await call(base, 'POST', '/api/keys/' + id + '/models/fetch');
    const fetched = r.data.models.find(m => m.id === 'probe-model');
    assert.strictEqual(fetched.ctx, 128000);
    assert.strictEqual(fetched.ctxSrc, 'api');
    assert.strictEqual(fetched.outSrc, 'api');

    r = await call(base, 'PATCH', '/api/keys/' + id + '/models/probe-model', { ctx: 200000 });
    assert.strictEqual(r.status, 200);
    const edited = r.data.models.find(m => m.id === 'probe-model');
    assert.strictEqual(edited.ctx, 200000);
    assert.strictEqual(edited.ctxSrc, 'manual', '人改过的值不能再挂着「来自平台接口」');
    assert.strictEqual(edited.outSrc, 'api', '没动 out，它的来源要原样留着');
    assert.strictEqual(edited.src, 'manual');
  } finally {
    server.close();
  }
});

test('API：只改 note 不动数值时，按字段来源原样保留', async () => {
  const { server, base } = await startServer(SOURCED_FETCH);
  try {
    const r0 = await call(base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-probe-note-02' });
    const id = r0.data.key.id;
    await call(base, 'POST', '/api/keys/' + id + '/models/fetch');
    const r = await call(base, 'PATCH', '/api/keys/' + id + '/models/probe-model', { note: 'n8n' });
    const m = r.data.models.find(x => x.id === 'probe-model');
    assert.strictEqual(m.note, 'n8n');
    assert.strictEqual(m.ctxSrc, 'api', '没改数值就不该动来源');
    assert.strictEqual(m.outSrc, 'api');
    assert.strictEqual(m.src, 'api');
  } finally {
    server.close();
  }
});

/* 告警位挂在记录上、数值另走一份，两者会分家：手改过 ctx 之后，上次拉取留下的
   「最大输出超过上下文」还在亮着，可屏幕上那两个数字明明是 out < ctx。 */
['sqlite', 'json'].forEach(function (backend) {
  test(backend + ' 后端：outGtCtx 按读到的 ctx/out 重算，不吃库里存的旧位', () => {
    const k = fresh(backend);
    k.store.replaceModels(k.id, [
      { id: 'stale', ctx: 1048576, out: 131072, outGtCtx: true, src: 'api' },
      { id: 'real', ctx: 32768, out: 131072, src: 'api' }
    ]);
    const rows = k.store.getKey(k.id).models;
    assert.strictEqual(rows.find(m => m.id === 'stale').outGtCtx, null, '数值已经反了就不该再亮');
    assert.strictEqual(rows.find(m => m.id === 'real').outGtCtx, true, '平台真的自相矛盾时该亮');
  });
});

test('两个后端都把同 id 的重复行折叠成一条，后到的只补空缺', () => {
  const read = (backend) => {
    const k = fresh(backend);
    k.store.replaceModels(k.id, [
      { id: 'dup-1', ctx: 262144, out: null, src: 'api', reasoning: null },
      { id: 'dup-1', ctx: 131072, out: 131072, src: 'api', reasoning: true }
    ]);
    const rows = k.store.getKey(k.id).models;
    return { n: rows.length, row: rows[0] && { ctx: rows[0].ctx, out: rows[0].out, reasoning: rows[0].reasoning } };
  };
  const a = read('sqlite');
  const b = read('json');
  assert.strictEqual(a.n, 1);
  assert.deepStrictEqual(a, b, '两个后端对同一批重复行要给出一样的结果');
  assert.deepStrictEqual(a.row, { ctx: 262144, out: 131072, reasoning: true }, '第一条赢，缺的字段由后一条补上');
});

/* 真实后果：某些平台的 /models 会把同一个 id 列两次。SQLite 上有 UNIQUE(key_id, id)，
   第二条插入直接把整次拉取顶成 500，用户一个模型都看不到。 */
test('API：/models 返回重复 id 时拉取照常成功', async () => {
  const fetchImpl = () => Promise.resolve(new Response(JSON.stringify({
    data: [
      { id: 'dup-1', context_length: 262144 },
      { id: 'dup-1', max_output_tokens: 131072 }
    ]
  }), { status: 200 }));
  const { server, base } = await startServer(fetchImpl);
  try {
    const r0 = await call(base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-dup-0001' });
    const id = r0.data.key.id;
    const r = await call(base, 'POST', '/api/keys/' + id + '/models/fetch');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const rows = (r.data.models || []).filter(m => m.id === 'dup-1');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ctx, 262144);
    assert.strictEqual(rows[0].out, 131072);
    assert.strictEqual(rows[0].outGtCtx, null);
  } finally {
    server.close();
  }
});
