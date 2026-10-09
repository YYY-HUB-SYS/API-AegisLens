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

/* ---------- 接口与限制一览（docs/API.md / API_EN.md）---------- */
/* 2026-10-09 把四列功能矩阵从 README 挪进了 docs/：README 负责让人 60 秒跑起来，
   手册负责把每条路径和每个数字钉在代码上。盯的对象换了文件，盯的强度不能降——
   两条方向都要堵：文档写了代码里没有的接口（吹出来的能力），
   和中英文各写各的（这轮之前刚撞上 EN 徽标比 ZH 落后 71 条测试那种单边漂移）。 */

const API_DOCS = ['docs/API.md', 'docs/API_EN.md'];

/* 两个口径都要有：47 是「方法 + 路径」的组合数，38 是去重后的路径形状数。
   只写一个数就会重演我上一轮那件事——README 写 461/417，谁都不知道在说什么。 */
const CREDENTIAL_ROUTES = [
  ['GET', '/api/credentials'], ['POST', '/api/credentials'], ['GET', '/api/credentials/health'],
  ['GET', '/api/credentials/{id}'], ['PUT', '/api/credentials/{id}'], ['DELETE', '/api/credentials/{id}'],
  ['POST', '/api/credentials/{id}/reveal'], ['GET', '/api/credentials/{id}/totp'],
  ['GET', '/api/credentials/{id}/password-policy']
];
const CONSUMER_ROUTES = [
  ['GET', '/api/consumer/tokens'], ['POST', '/api/consumer/tokens'],
  ['POST', '/api/consumer/tokens/{tid}/revoke'],
  ['GET', '/api/consumer/keys/{id}'], ['POST', '/api/consumer/keys/{id}/test'],
  ['GET', '/api/consumer/keys/{id}/balance'], ['GET', '/api/consumer/credentials/{id}']
];
/* 上面两份是**接口面快照**：这两个子模块按 URL 段手写分发，机器抽不出来。
   快照被改错时下面三条测试会红，改的人就得同时改 README —— 这正是要的效果。 */

function normRoutePath(p) {
  return p.replace(/\\\//g, '/')
    .replace(/\(\\d\+\)/g, '{id}')
    .replace(/\(\[0-9a-f\]\{24\}\)/g, '{tid}')
    .replace(/\(\[\^\/\]\+\)/g, '{seg}');
}

function routePairsInCode() {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'src', 'api.js'), 'utf8');
  const pairs = [];
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/req\.method === '([A-Z]+)'/);
    if (!m) continue;
    const lit = line.match(/path === '(\/api\/[^']+)'/);
    if (lit) { pairs.push([m[1], lit[1]]); continue; }
    const rx = line.match(/\/\^\\\/api\\\/[^\n]*?\$\//);
    if (rx) pairs.push([m[1], normRoutePath(rx[0].slice(2, -2))]);
  }
  return pairs.concat(CREDENTIAL_ROUTES, CONSUMER_ROUTES);
}

function pathShapesInCode() {
  return Array.from(new Set(routePairsInCode().map(p => p[1]))).sort();
}

/* 文档里的占位名是给人读的（{tool} / {modelId} / {keyId}），代码里的正则抽出来是 {seg} / {id}。
   对账对的是**结构**，所以两边都归到同一个占位符；不然就是拿命名习惯当缺陷。 */
function canonPath(p) {
  return p.replace(/\{[A-Za-z0-9]+\}/g, '{param}');
}

function pathsIn(text) {
  const found = (text.match(/\/api\/[A-Za-z0-9_:\/{}-]+/g) || [])
    .map(p => canonPath(p.replace(/\/+$/, '')
      .replace(/\/\d+(?=\/|$)/g, '/{id}')      /* curl 示例里的真实 id */
      .replace(/\/:id\b/g, '/{id}')             /* 文档里另一种写法，归一到同一个 */
      .replace(/\/:tid\b/g, '/{tid}')))
    .filter(p => p.length > '/api/'.length);
  return Array.from(new Set(found)).sort();
}

test('文档里出现的每个 /api 路径，代码里都必须真有这条路由', () => {
  const shapes = pathShapesInCode();
  assert.ok(shapes.length >= 30, '代码侧路由抽取失败（只抓到 ' + shapes.length + ' 条形状），这条测试现在是空转');
  const known = new Set(shapes.map(canonPath));
  for (const doc of ['README.md', 'README_EN.md'].concat(API_DOCS)) {
    const invented = pathsIn(read(doc)).filter(p => !known.has(p));
    assert.deepStrictEqual(invented, [], doc + ' 写了代码里不存在的路径（或者路径名写错了）：' + invented.join(', '));
  }
});

/* 手册里那两个路由数是会被引用的。数字允许随代码增长，但只允许**跟代码一致**。 */
function numberRow(text, labelRx) {
  const line = String(text).split(/\r?\n/).find(function (l) { return labelRx.test(l); });
  assert.ok(line, '手册里找不到这一行：' + labelRx);
  return (line.match(/\d+/g) || []).map(Number);
}

test('接口一览写的路由数（方法+路径组合 / 去重路径形状）必须与代码一致', () => {
  const pairs = routePairsInCode().length;
  const shapes = pathShapesInCode().length;
  assert.ok(pairs >= shapes, '组合数不该小于形状数');
  for (const doc of API_DOCS) {
    const nums = numberRow(read(doc), /路由总数|Total routes/);
    assert.ok(nums.indexOf(pairs) > -1, doc + ' 的「路由总数」那一行没有代码实数 ' + pairs + '（该行数字：' + nums.join(',') + '）');
    assert.ok(nums.indexOf(shapes) > -1, doc + ' 的「路由总数」那一行没有形状数 ' + shapes + '（该行数字：' + nums.join(',') + '）');
  }
});

/* 界面动作数同理：`data-act` 是三个前端文件里能机械数出来的，别让它变成一句好看的形容词。 */
function uiActionsInCode() {
  const files = ['public/index.html', 'public/credentials-view.js', 'public/consumer-view.js'];
  const set = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
    (src.match(/data-act="[a-z-]+"/g) || []).forEach(m => set.add(m.slice(10, -1)));
  }
  return Array.from(set).sort();
}

test('接口一览写的界面动作数（data-act 去重）必须与代码一致', () => {
  const n = uiActionsInCode().length;
  assert.ok(n >= 40, '界面动作抽取失败（只抓到 ' + n + ' 个）');
  for (const doc of API_DOCS) {
    const nums = numberRow(read(doc), /data-act/);
    assert.ok(nums.indexOf(n) > -1, doc + ' 的 data-act 那一行没有代码实数 ' + n + '（该行数字：' + nums.join(',') + '）');
  }
});

/* 中英两份手册必须同集合：路径漏一半，读英文版的人就会以为接口不存在。 */
test('中英 README 与中英接口一览的 /api 路径必须各自同集合（防单边漂移）', () => {
  const pairs = [['README.md', 'README_EN.md'], [API_DOCS[0], API_DOCS[1]]];
  for (const [zhDoc, enDoc] of pairs) {
    const a = pathsIn(read(zhDoc)), b = pathsIn(read(enDoc));
    assert.deepStrictEqual(a.filter(p => b.indexOf(p) === -1), [],
      '这些接口只在 ' + zhDoc + ' 里有，' + enDoc + ' 漏了');
    assert.deepStrictEqual(b.filter(p => a.indexOf(p) === -1), [],
      '这些接口只在 ' + enDoc + ' 里有，' + zhDoc + ' 漏了');
  }

  const zh = read('README.md'), en = read('README_EN.md');
  const va = Array.from(new Set(zh.match(/AKM_[A-Z0-9_]+/g) || [])).sort();
  const vb = Array.from(new Set(en.match(/AKM_[A-Z0-9_]+/g) || [])).sort();
  assert.deepStrictEqual(vb, va, '中英 README 的 AKM_ 变量集合不一致，英文侧：' + vb.join(','));
});

/* ---------- 文档之间的相对链接 ---------- */
/* 2026-10-09 把 README 重排之后，DEPLOYMENT 与 SECURITY 指进 README 的锚点全断了：
   文件还在、章节没了，Markdown 照样渲染成一句通顺的话，读者点下去才知道是死链。
   所以锚点也要机器对账——GitHub 的锚点规则：小写、去掉字母数字/空格/连字符以外的东西
   （emoji 和标点就这么没了，「⚖️ 许可与致谢」变成「-许可与致谢」），空格换成连字符。 */
const MD_DOCS = ['README.md', 'README_EN.md', 'DEPLOYMENT.md', 'DEPLOYMENT_EN.md',
  'SECURITY.md', 'SECURITY_EN.md'].concat(API_DOCS);

function slugify(headingText) {
  return String(headingText)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- ]/gu, '')
    .replace(/ /g, '-');
}

function anchorsIn(mdText) {
  const set = new Set();
  for (const line of String(mdText).split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) set.add(slugify(m[1]));
  }
  return set;
}

test('文档里的相对链接：文件必须存在，锚点必须真有其名（重排一次 README 就该跑这条）', () => {
  const anchors = new Map(MD_DOCS.map(function (d) { return [d, anchorsIn(read(d))]; }));
  const dead = [];
  for (const doc of MD_DOCS) {
    /* `./` 和 `../` 都得查：docs/API.md 里十之八九是 ../，只认 ./ 等于放过一半链接 */
    for (const m of String(read(doc)).matchAll(/\]\(((?:\.{1,2}\/)[^)\s]+)\)/g)) {
      const target = m[1];
      const hashAt = target.indexOf('#');
      const file = target.slice(0, hashAt === -1 ? target.length : hashAt);
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(doc), file));
      const anchor = hashAt === -1 ? '' : decodeURIComponent(target.slice(hashAt + 1));
      if (!fs.existsSync(path.join(ROOT, rel))) { dead.push(doc + ' → ' + target + '（文件不存在）'); continue; }
      if (!anchor) continue;
      const set = anchors.get(rel);
      if (!set) { dead.push(doc + ' → ' + target + '（这份文档没进锚点表，补进 MD_DOCS）'); continue; }
      if (!set.has(anchor)) dead.push(doc + ' → ' + target + '（没有这么一节）');
    }
  }
  assert.deepStrictEqual(dead, [], '死链：\n' + dead.join('\n'));
});

