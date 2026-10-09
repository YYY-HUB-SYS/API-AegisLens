/* 消费者令牌视图的纯逻辑单测：不碰浏览器，只调 __internals。
   挑出来的都是「界面说的话和发出去的请求对不上」那一类——这类缺陷接口测试看不见，
   后端也全对，只有把视图自己的裁剪逻辑单独拎出来才拦得住。 */
const { test } = require('node:test');
const assert = require('node:assert');
const view = require('../public/consumer-view.js');
const tokens = require('../src/consumer-tokens.js');

const eff = view.__internals.effectiveIds;

/* 界面把后端的额度抄了一份写死的（consumer-view.js 那几行注释就是来源）。
   抄一份本身有理由——浏览器拿不到服务端常量；但抄了就没人负责它跟着变。
   后端一改，界面会继续让用户填一个必被 400 拒掉的值，而且拒得很突然。 */
test('消费者视图里抄的额度常量，必须和 consumer-tokens 的实际值逐条一致', () => {
  const l = view.__internals.limits;
  assert.deepStrictEqual([...l.SCOPES].sort(), [...tokens.SCOPES].sort(),
    '作用域集合不一致（顺序可以不同，集合不能差）');
  assert.strictEqual(l.MAX_LABEL, tokens.MAX_LABEL_LEN, 'label 上限');
  assert.strictEqual(l.MAX_RESOURCE, tokens.MAX_TOTAL_RESOURCE_IDS, '资源条目合计上限');
  assert.strictEqual(l.MIN_TTL, tokens.MIN_TTL_SECONDS, '最短有效期');
  assert.strictEqual(l.MAX_TTL, tokens.MAX_TTL_SECONDS, '最长有效期');
  assert.strictEqual(l.TTL_DEFAULT, tokens.DEFAULT_TTL_SECONDS, '默认有效期');
});

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
