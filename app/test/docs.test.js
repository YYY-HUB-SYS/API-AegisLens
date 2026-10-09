/* 文档一致性：把「代码里的配置」和「文档承诺的配置」对起来。
   这类漂移不会让任何接口测试变红——变量能读、界面能用，只是照着文档部署的人
   少配了一项，或多配了一项根本不存在的。 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = function (p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); };

/* 代码是唯一的权威：src/ 与 server.js 里读到的 AKM_* 就是全部对外配置面 */
function varsInCode() {
  const files = fs.readdirSync(path.join(ROOT, 'app', 'src')).filter(function (f) { return f.endsWith('.js'); });
  const found = new Set();
  files.concat(['server.js']).forEach(function (f) {
    const p = f === 'server.js' ? path.join(ROOT, 'app', 'server.js') : path.join(ROOT, 'app', 'src', f);
    String(fs.readFileSync(p, 'utf8')).replace(/AKM_[A-Z0-9_]+/g, function (m) { found.add(m); return m; });
  });
  return Array.from(found).sort();
}

const DOCS = ['DEPLOYMENT.md', 'DEPLOYMENT_EN.md', 'index.html'];

test('代码里读的每一个 AKM_ 环境变量，三份配置文档都得有（漏一个就是读者少配一项）', () => {
  const vars = varsInCode();
  assert.ok(vars.length >= 8, '至少要覆盖端口/绑定/数据目录/口令/闲置锁/代理/调度两条，实得：' + vars.join(','));
  for (const doc of DOCS) {
    const text = read(doc);
    const missing = vars.filter(function (v) { return text.indexOf(v) === -1; });
    assert.deepStrictEqual(missing, [], doc + ' 缺这些环境变量的说明：' + missing.join(', '));
  }
});

test('文档不许凭空发明变量：写出来的 AKM_ 名字必须在代码里真被读过', () => {
  const vars = varsInCode();
  for (const doc of DOCS) {
    const invented = Array.from(new Set(String(read(doc)).match(/AKM_[A-Z0-9_]+/g) || []))
      .filter(function (v) { return vars.indexOf(v) === -1; });
    assert.deepStrictEqual(invented, [], doc + ' 写了代码里没人读的变量：' + invented.join(', '));
  }
});

/* 「全程只监听 127.0.0.1」在 AKM_BIND 之后就不成立了：那是默认值，不是不变量。
   措辞必须带「默认」，否则主页在替一个已经能放开的能力说谎。 */
test('首页不能把默认回环监听说成不可更改的事实', () => {
  const html = read('index.html');
  for (const claim of ['全程只监听', '服务只绑定', '127.0.0.1 only']) {
    assert.ok(html.indexOf(claim) === -1, '这句绝对化表述回来了：' + claim);
  }
  assert.match(html, /默认只监听 <code>127\.0\.0\.1/, '首页要说清 127.0.0.1 是默认值');
  assert.match(html, /默认只绑定 <code>127\.0\.0\.1/, '安全卡片里同样要带「默认」');
  assert.match(html, /没设解锁口令时这样设会直接启动失败/, '放开监听的前提（先设口令）必须写在同一张卡片上');
});

/* PRD 是实现之前的设计意图，第 13 节还写着「主密钥托管系统钥匙串、不落盘」——
   实现走的是 master.key 同目录那条路。差异声明是这份文档唯一的解毒剂，别让它悄悄消失。 */
test('产品设计文档顶部那条「与设计有差异」声明必须还在', () => {
  const prd = read(path.join('api-aegislens-prd', 'api-aegislens-prd.html'));
  assert.ok(prd.indexOf('这份设计文档与已发布实现的差异') > -1,
    '差异声明被删了：读者会把没实现的钥匙串方案当成现状');
  assert.ok(prd.indexOf('没有实现') > -1 || prd.indexOf('没做') > -1,
    '钥匙串那条要写明没实现');
});
