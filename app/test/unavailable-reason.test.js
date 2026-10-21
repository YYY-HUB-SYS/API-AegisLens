/* 「查不到额度」的原因要说准：接口存在但凭据类型不对 ≠ 平台压根没这个接口。
   2026-10-21 复核过三家的事实（都在本机实测过，判据见 balance-apis.js 里的注释）：
   · OpenAI /v1/usage 只对组织管理员开放（要 admin key），普通项目 key 查不到；
   · xAI 的账单接口在 management-api.x.ai，要 management key（sk- 推理 key 被拒）；
   · 火山方舟的 GetInferenceUsage / ListModelRateLimit 只认 Access Key 签名。
   这三家原来的文案是「没有公开的用量/限额接口」—— 把用户指到了错误的地方。 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const tmp = require('./tmp.js');
const adapters = require('../src/adapters');
const balanceApis = require('../src/balance-apis.js');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');
const { createApp } = require('../src/app');

test('三家的用量原因各说各的，不是一句「没有公开接口」', () => {
  const oa = balanceApis.usageUnavailableReason(['https://api.openai.com/v1']);
  const xai = balanceApis.usageUnavailableReason(['https://api.x.ai/v1']);
  const ark = balanceApis.usageUnavailableReason(['https://ark.cn-beijing.volces.com/api/v3']);
  assert.match(oa, /admin key/);
  assert.match(xai, /management key/);
  assert.match(ark, /Access Key/);
  /* 三条必须互不相同 —— 一旦一样，就说明又退化成一句通用文案 */
  assert.notStrictEqual(oa, xai);
  assert.notStrictEqual(oa, ark);
  assert.notStrictEqual(xai, ark);
  for (const s of [oa, xai, ark]) {
    assert.doesNotMatch(s, /没有公开的用量\/限额接口/);
  }
});

test('未知平台走默认文案；空端点与 null 都不炸', () => {
  assert.match(balanceApis.usageUnavailableReason(['https://example.invalid/v1']), /没有公开的用量\/限额接口/);
  assert.match(balanceApis.usageUnavailableReason([]), /没有公开的用量\/限额接口/);
  assert.match(balanceApis.usageUnavailableReason(null), /没有公开的用量\/限额接口/);
  assert.match(balanceApis.usageUnavailableReason(undefined), /没有公开的用量\/限额接口/);
});

test('多端点里任一命中即可（对象形态与字符串形态都认）', () => {
  const r = balanceApis.usageUnavailableReason([
    { url: 'https://example.invalid/v1' },
    { url: 'https://api.x.ai/v1' }
  ]);
  assert.match(r, /management key/);
  const r2 = balanceApis.usageUnavailableReason(['https://example.invalid/v1', 'https://api.x.ai/v1']);
  assert.match(r2, /management key/);
});

test('余额侧与用量侧的说法分开', () => {
  assert.match(balanceApis.balanceUnavailableReason(['https://api.x.ai/v1']), /management key/);
  assert.match(balanceApis.balanceUnavailableReason(['https://example.invalid/v1']), /没有公开的余额接口/);
});

test('adapters 这一层转发得对（api.js 走的是 adapters）', () => {
  assert.match(adapters.usageUnavailableReason(['https://api.openai.com/v1']), /admin key/);
  assert.match(adapters.balanceUnavailableReason(['https://ark.cn-beijing.volces.com/api/v3']), /Access Key/);
});

test('代理提示：没配代理才提示，配了就不提', () => {
  assert.match(adapters.proxyHintFor(null), /AKM_PROXY/);
  assert.match(adapters.proxyHintFor(''), /AKM_PROXY/);
  assert.strictEqual(adapters.proxyHintFor('http://127.0.0.1:7897'), '');
});

test('接口出口：OpenAI 的「查限额」回的是平台专属原因，不是笼统文案', async () => {
  const dir = tmp.mk('akm-reason');
  const mk = loadOrCreateMasterKey(dir);
  const storage = createStore(dir, mk, { backend: 'json' });
  const server = createApp({
    storage: storage,
    fetchImpl: function () { return Promise.resolve(new Response('{}', { status: 404 })); },
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test'
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const call = function (method, p, body) {
      return fetch(base + p, {
        method: method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
      }).then(function (res) {
        return res.json().then(function (data) { return { status: res.status, data: data }; });
      });
    };
    let r = await call('POST', '/api/keys', { platform: 'openai', key: 'sk-openai-reason-1234' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const id = r.data.key.id;
    r = await call('POST', '/api/keys/' + id + '/usage');
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error || '', /admin key/);
    /* 反例断言：不能退回那句笼统文案 */
    assert.doesNotMatch(r.data.error || '', /没有公开的用量\/限额接口/);
  } finally {
    server.close();
  }
});
