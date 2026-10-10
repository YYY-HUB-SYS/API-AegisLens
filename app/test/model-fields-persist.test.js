/* 模型扩展字段必须能穿过持久层往返。
   SQLite 后端原先只白名单 (id, ctx, out, src, note) 五列，
   按字段来源与能力位写入即被静默丢弃 —— 界面读回来永远是空的。
   现在非白名单字段统一存进 models.extra 一列 JSON。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = require('./tmp.js');
const { createStore } = require('../src/storage');

const FIELDS = {
  id: 'deepseek-chat', ctx: 131072, out: 8192, src: 'api',
  ctxSrc: 'api', outSrc: 'web', conflict: true, outGtCtx: null, // outGtCtx 读取时按 ctx/out 重算，false 不可表示（true 的情形钉在 model-write-path.test.js）
  reasoning: true, modalitiesIn: ['text', 'image'], rpm: 2640, note: null
};

function newDir() { return tmp.mk('aegis-mfield'); }

/* store 没有 close()，SQLite 句柄要等进程退出才释放，Windows 上目录因此删不掉。
   清理只能是尽力而为 —— 断言已经跑完，删不动不该让测试变红。 */
function sweep(dir) {
  try { sweep(dir); } catch (e) { /* 句柄未释放，留给 OS */ }
}

function fresh(backend) {
  const dir = newDir();
  const store = createStore(dir, Buffer.alloc(32, 7), { backend: backend });
  const k = store.createKey({
    platform: 'deepseek', name: 'probe', key: 'sk-probe-0001',
    endpoints: [{ url: 'https://api.deepseek.com', style: 'openai' }]
  });
  return { dir: dir, store: store, id: k.id };
}

['sqlite', 'json'].forEach(function (backend) {
  test(backend + ' 后端：replaceModels 后按字段来源与能力位不丢失', () => {
    const c = fresh(backend);
    try {
      c.store.replaceModels(c.id, [Object.assign({}, FIELDS)]);
      const back = c.store.listKeys()[0].models[0];
      Object.keys(FIELDS).forEach(function (k) {
        assert.deepStrictEqual(back[k], FIELDS[k], backend + ' 把 ' + k + ' 丢了或改值了');
      });
    } finally { sweep(c.dir); }
  });

  test(backend + ' 后端：局部 upsert 只改一个能力位，不能抹掉已有的 ctxSrc', () => {
    const c = fresh(backend);
    try {
      c.store.replaceModels(c.id, [Object.assign({}, FIELDS)]);
      c.store.upsertModel(c.id, { id: 'deepseek-chat', reasoning: false });
      const m = c.store.listKeys()[0].models[0];
      assert.strictEqual(m.reasoning, false, '新值要生效');
      assert.strictEqual(m.ctxSrc, 'api', '补丁没带的字段必须原样保留');
      assert.strictEqual(m.outSrc, 'web');
      assert.strictEqual(m.rpm, 2640);
    } finally { sweep(c.dir); }
  });

  test(backend + ' 后端：重新打开存储后扩展字段仍在（真落盘，不是内存对象）', () => {
    const dir = newDir();
    try {
      const a = createStore(dir, Buffer.alloc(32, 7), { backend: backend });
      const k = a.createKey({
        platform: 'deepseek', name: 'probe', key: 'sk-probe-0001',
        endpoints: [{ url: 'https://api.deepseek.com', style: 'openai' }]
      });
      a.replaceModels(k.id, [Object.assign({}, FIELDS)]);
      const b = createStore(dir, Buffer.alloc(32, 7), { backend: backend });
      const m = b.listKeys()[0].models[0];
      assert.strictEqual(m.ctxSrc, 'api');
      assert.deepStrictEqual(m.modalitiesIn, ['text', 'image']);
      assert.strictEqual(m.rpm, 2640);
    } finally { sweep(dir); }
  });
});

test('extra 列损坏时退回五个基础字段，不整条读不出', () => {
  const c = fresh('sqlite');
  try {
    c.store.replaceModels(c.id, [Object.assign({}, FIELDS)]);
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(c.dir, 'keys.db'));
    raw.prepare('UPDATE models SET extra = ?').run('{not json');
    raw.close();
    const again = createStore(c.dir, Buffer.alloc(32, 7), { backend: 'sqlite' });
    const m = again.listKeys()[0].models[0];
    assert.strictEqual(m.id, 'deepseek-chat');
    assert.strictEqual(m.ctx, 131072, '基础字段仍要读得出');
    assert.strictEqual(m.ctxSrc, undefined);
  } finally { sweep(c.dir); }
});
