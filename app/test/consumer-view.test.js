/* 消费者令牌视图的纯逻辑单测：不碰浏览器，只调 __internals。
   挑出来的都是「界面说的话和发出去的请求对不上」那一类——这类缺陷接口测试看不见，
   后端也全对，只有把视图自己的裁剪逻辑单独拎出来才拦得住。 */
const { test } = require('node:test');
const assert = require('node:assert');
const view = require('../public/consumer-view.js');

const eff = view.__internals.effectiveIds;

test('没勾对应作用域的那一类资源，不能跟着进令牌（提示语一直是这么写的）', () => {
  /* 旧行为：draft 里勾了就全发。disabled 的 checkbox 在 :checked 里照样命中，
     于是签出一把 scopes 里没有 key:read、却绑着 3 把密钥的令牌——列表显示「密钥 3」，
     实际一把都读不到，事后看不出当时为什么这么签。 */
  const d = { scopes: ['cred:read'], keyIds: [1, 2, 3], credIds: [7] };
  assert.deepStrictEqual(eff(d), { keyIds: [], credIds: [7] });
  const both = { scopes: ['key:read', 'cred:read'], keyIds: [1, 2, 3], credIds: [7] };
  assert.deepStrictEqual(eff(both), { keyIds: [1, 2, 3], credIds: [7] });
});

test('balance:read 这类没有资源清单的作用域，不该把另一类的勾选顺带清掉', () => {
  /* key:read / cred:read 才各自决定一类资源；balance 与 key:test 用同一份 keyIds。 */
  const d = { scopes: ['key:test', 'balance:read'], keyIds: [4, 5], credIds: [9] };
  assert.deepStrictEqual(eff(d), { keyIds: [4, 5], credIds: [] });
});

test('draft 残缺时不能炸：scopes 缺失就是两类都不给', () => {
  assert.deepStrictEqual(eff({}), { keyIds: [], credIds: [] });
  assert.deepStrictEqual(eff(null), { keyIds: [], credIds: [] });
  assert.deepStrictEqual(eff({ scopes: ['key:read'] }), { keyIds: [], credIds: [] });
});
