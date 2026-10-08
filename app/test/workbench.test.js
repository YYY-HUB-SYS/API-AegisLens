const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const batPath = path.join(__dirname, '..', 'workbench.bat');
const jsonPath = path.join(__dirname, '..', 'workbench.json');
const homepagePath = path.join(__dirname, '..', 'public', 'index.html');
const repoRoot = path.join(__dirname, '..', '..');

function readHomepage() {
  return fs.readFileSync(homepagePath, 'utf8');
}

function readBat() {
  const buf = fs.readFileSync(batPath);
  return { buf: buf, text: buf.toString('utf8') };
}

function readPayload() {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

test('workbench.bat：UTF-8 无 BOM（BOM 会导致首行 @echo off 解析失败）', () => {
  const { buf } = readBat();
  assert.ok(
    !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf),
    '文件不应以 UTF-8 BOM 开头'
  );
});

test('workbench.bat：全部使用 CRLF 行尾（批处理标准，避免块解析异常）', () => {
  const { text } = readBat();
  assert.ok(text.includes('\r\n'), '应包含 CRLF 行尾');
  const loneLf = text.replace(/\r\n/g, '');
  assert.ok(!loneLf.includes('\n'), '不应存在孤立的 LF');
});

test('workbench.bat：chcp 65001 必须先于任何中文执行（日志由工作台按 UTF-8 捕获）', () => {
  const { text } = readBat();
  const chcpIdx = text.indexOf('chcp 65001');
  assert.ok(chcpIdx > 0, '应包含 chcp 65001');
  const firstChinese = text.search(/[\u4e00-\u9fff]/);
  assert.ok(
    firstChinese === -1 || firstChinese > chcpIdx,
    '中文字符只能出现在 chcp 65001 之后'
  );
});

test('workbench.bat：前台运行 node（不弹新窗口、不自动开浏览器，进程与日志由工作台托管）', () => {
  const { text } = readBat();
  assert.ok(text.includes('node server.js'), '应前台运行 node server.js');
  assert.ok(!text.includes('cmd /k'), '不应弹独立控制台窗口');
  assert.ok(!text.includes('http://'), '不应自动打开浏览器（打开动作交给工作台的 open）');
});

test('workbench.bat：切换到脚本所在目录（server.js 依赖相对路径定位 public/src）', () => {
  const { text } = readBat();
  assert.ok(text.includes('cd /d "%~dp0"'));
});

test('workbench.json：合法 JSON 且 script 类型必填字段完整', () => {
  const p = readPayload();
  assert.strictEqual(p.type, 'script');
  assert.ok(p.name && p.name.length <= 100, 'name 必填且 ≤100 字符');
  assert.ok(Array.isArray(p.ports) && p.ports.includes(37700), 'ports 应含服务端口 37700');
  assert.ok(
    Array.isArray(p.urls) && p.urls.some((u) => u.includes('37700')),
    'urls 应含 http://127.0.0.1:37700'
  );
});

test('workbench.json：id 符合工作台字符集规范且 path 指向真实存在的脚本', () => {
  const p = readPayload();
  assert.match(p.id, /^[a-zA-Z0-9._-]+$/, 'id 只允许字母数字与 . _ -');
  // 钉死某台机器的绝对路径会让任何 clone 都测不过，故 path 允许仓库相对路径，按仓库根解析后再断言
  const resolvedPath = path.isAbsolute(p.path) ? p.path : path.join(repoRoot, p.path);
  assert.ok(fs.existsSync(resolvedPath), `path 应指向真实文件: ${p.path}`);
  assert.ok(/[\\/](workbench\.bat)$/i.test(p.path), 'path 应指向 workbench.bat');
});

test('workbench.json：processMatch 与服务进程命令行一致（手动启动的实例也能被工作台识别）', () => {
  const p = readPayload();
  assert.strictEqual(p.options && p.options.processMatch, 'server.js');
});

test('workbench.json：端口/地址与 start.bat 手动入口保持一致', () => {
  const startBat = fs.readFileSync(path.join(__dirname, '..', 'start.bat'), 'utf8');
  const p = readPayload();
  assert.ok(
    startBat.includes(String(p.ports[0])),
    '两个启动入口应指向同一端口'
  );
});

test('工作台页面：包含筛选标签栏（filter-bar）', () => {
  const html = readHomepage();
  assert.ok(html.includes('id="filter-bar"'), '应包含 filter-bar 容器');
  assert.ok(html.includes('class="filter-bar"'), 'filter-bar 应有 filter-bar class');
  assert.ok(html.includes('data-filter='), 'JS 应使用 data-filter 属性生成筛选标签');
  assert.ok(html.includes("key: 'all'"), 'JS 应定义「全部」筛选项');
  assert.ok(html.includes("key: 'ok'"), 'JS 应定义「有效」筛选项');
  assert.ok(html.includes("key: 'warn'"), 'JS 应定义「临期」筛选项');
  assert.ok(html.includes("key: 'exp'"), 'JS 应定义「过期/停用」筛选项');
});

test('工作台页面：筛选 JS 状态变量与渲染函数', () => {
  const html = readHomepage();
  assert.ok(html.includes("filter: 'all'"), 'JS 初始状态应设 filter 为 all');
  assert.ok(html.includes('function renderFilterTabs'), '应定义 renderFilterTabs 函数');
  assert.ok(html.includes('renderFilterTabs()'), 'render 函数应调用 renderFilterTabs');
});

test('工作台页面：筛选 CSS 样式已定义', () => {
  const html = readHomepage();
  assert.ok(html.includes('.filter-bar'), 'CSS 应定义 .filter-bar 样式');
  assert.ok(html.includes('.filter-bar button'), 'CSS 应定义 .filter-bar button 样式');
  assert.ok(html.includes('.filter-bar button.active'), 'CSS 应定义 .filter-bar .active 样式');
});

test('工作台页面：导出/导入按钮存在', () => {
  const html = readHomepage();
  assert.ok(html.includes('id="btn-export"'), '应包含导出按钮');
  assert.ok(html.includes('id="btn-import"'), '应包含导入按钮');
  assert.ok(html.includes('导出'), '导出按钮应有文字');
  assert.ok(html.includes('导入'), '导入按钮应有文字');
});

test('工作台页面：导出弹窗结构完整', () => {
  const html = readHomepage();
  assert.ok(html.includes('id="overlay-export"'), '应包含导出弹窗');
  assert.ok(html.includes('id="export-select-all"'), '导出弹窗应有全选复选框');
  assert.ok(html.includes('id="export-list"'), '导出弹窗应有密钥列表容器');
  assert.ok(html.includes('id="btn-export-confirm"'), '导出弹窗应有确认按钮');
  assert.ok(html.includes('class="export-cb"'), '导出列表项应有复选框');
});

test('工作台页面：导入弹窗结构完整', () => {
  const html = readHomepage();
  assert.ok(html.includes('id="overlay-import"'), '应包含导入弹窗');
  assert.ok(html.includes('id="import-sub"'), '导入弹窗应有说明文字');
  assert.ok(html.includes('id="import-body"'), '导入弹窗应有内容容器');
  assert.ok(html.includes('id="btn-import-exec"'), '导入弹窗应有执行按钮');
  assert.ok(html.includes('id="file-input"'), '应包含隐藏的文件输入');
  assert.ok(html.includes('accept=".json"'), '文件输入应限定 JSON 格式');
});

test('工作台页面：导出/导入 JS 逻辑存在', () => {
  const html = readHomepage();
  assert.ok(html.includes('renderExportList'), '应定义 renderExportList 函数');
  assert.ok(html.includes('updateExportCount'), '应定义 updateExportCount 函数');
  assert.ok(html.includes('doImport'), '应定义 doImport 函数');
  assert.ok(html.includes('api-aegislens-export'), '导出格式标识应定义');
  assert.ok(html.includes('POST\', \'/import\''), '导入应调用 POST /api/import');
  assert.ok(html.includes('GET\', \'/keys\''), '导入后应刷新密钥列表');
});

test('工作台页面：导出/导入 CSS 样式已定义', () => {
  const html = readHomepage();
  assert.ok(html.includes('.export-item'), 'CSS 应定义 .export-item 样式');
  assert.ok(html.includes('.export-select-all'), 'CSS 应定义 .export-select-all 样式');
  assert.ok(html.includes('.export-list'), 'CSS 应定义 .export-list 样式');
  assert.ok(html.includes('.import-grid'), 'CSS 应定义 .import-grid 样式');
  assert.ok(html.includes('.import-item'), 'CSS 应定义 .import-item 样式');
  assert.ok(html.includes('.import-result'), 'CSS 应定义 .import-result 样式');
  assert.ok(html.includes('.import-detail'), 'CSS 应定义 .import-detail 样式');
});
test('生成配置：端点风格与工具协议不匹配时必须出警告', () => {
  const html = readHomepage();
  assert.ok(html.includes('var mismatch = !!(ep && ep.style !== want)'), '应计算端点风格不匹配');
  assert.ok(html.includes('没有 Anthropic 兼容端点'), 'Claude Code 缺 Anthropic 端点时要警告');
  assert.ok(html.includes('不是 OpenAI 兼容'), 'Dify/n8n 拿到非 OpenAI 兼容端点时要警告');
  assert.ok(!html.includes("else cl.push('# 未配置 Anthropic 兼容地址');"), '原先那段永不可达的死分支应已被替换');
});
test('卡片头部与导入导出列表：自动名重复平台名时只显示尾巴', () => {
  const html = readHomepage();
  assert.ok(html.includes('function shortName(k)'), '应有 shortName 助手');
  assert.equal((html.match(/esc\(shortName\(k\)\)/g) || []).length, 3,
    '卡片头部 + 导出列表 + 导入预览 三处都该去重');
  assert.ok(!html.includes("'<span class=\"kname\">' + esc(k.name)"), '不应再有直接输出 k.name 的 kname');
});

test('弹层互斥：openOverlay 必须先关掉已开的弹层', () => {
  const html = readHomepage();
  const fn = html.slice(html.indexOf('function openOverlay(id)'), html.indexOf('function closeOverlay(id)'));
  assert.ok(fn.includes('.overlay.show'), 'openOverlay 内应清理已显示的弹层');
  var clearAt = fn.indexOf('.overlay.show');
  var addAt = fn.indexOf('classList.add');
  assert.ok(clearAt > -1 && addAt > -1 && clearAt < addAt, '必须先关掉已开的再开新的');
});

test('四个弹层都必须有可点的关闭入口', () => {
  const html = readHomepage();
  for (const id of ['overlay-form', 'overlay-config', 'overlay-export', 'overlay-import']) {
    const re = new RegExp('data-close=' + String.fromCharCode(34) + id + String.fromCharCode(34));
    assert.ok(re.test(html), '缺少关闭按钮：' + id);
  }
});
test('页脚不得脱离文档流（悬浮状态条会压住最后一张卡片）', () => {
  const html = readHomepage();
  const at = html.indexOf('  .foot {');
  assert.ok(at > -1, '应定义 .foot 样式');
  const rule = html.slice(at, at + 240);
  assert.ok(!/position:\s*(fixed|sticky)/.test(rule), '.foot 必须留在文档流内');
});

test('卡片主标题只放密钥名，平台名交给组标题承担', () => {
  const html = readHomepage();
  assert.ok(html.includes("'<span class=\"plat\">' + esc(shortName(k)) + '</span>'"),
    '卡片标题应为 shortName，不再重复组标题里的平台名');
  assert.equal((html.match(/class="plat-dot"/g) || []).length, 3,
    '色点应为组标题 + 导出列表 + 导入预览三处');
});

test('空状态自带新增入口，且由事件委托接住', () => {
  const html = readHomepage();
  assert.equal((html.match(/data-act="empty-add"/g) || []).length, 2,
    '静态空状态与动态空状态各一处按钮');
  assert.ok(html.includes("getElementById('empty').addEventListener"),
    '#empty 应有委托监听，否则动态渲染的按钮点不动');
});

test('窄屏：参数胶囊必须能被压进容器，不许撑出横向滚动', () => {
  const html = readHomepage();
  const at = html.indexOf('  .param {');
  assert.ok(at > -1, '应定义 .param 样式');
  const rule = html.slice(at, at + 220);
  assert.ok(/max-width:\s*100%/.test(rule), '.param 需设 max-width: 100%');
  assert.ok(/min-width:\s*0/.test(rule), '.param 需解除 flex 子项的 min-width:auto');
});

test('主题开关：两套令牌齐全，且首屏前就落 data-theme', () => {
  const html = readHomepage();
  assert.ok(html.includes(':root[data-theme="dark"]'), '应有暗色令牌块');
  const darkBlock = html.slice(html.indexOf(':root[data-theme="dark"]'));
  const lightBlock = html.slice(0, html.indexOf(':root[data-theme="dark"]'));
  for (const tok of ['--bg', '--surface', '--ink', '--ink-2', '--rule', '--accent', '--api', '--warn', '--danger']) {
    assert.ok(lightBlock.includes(tok + ':'), '浅色缺令牌 ' + tok);
    assert.ok(darkBlock.slice(0, 1400).includes(tok + ':'), '暗色缺令牌 ' + tok);
  }
  assert.ok(html.includes("localStorage.getItem('aegis-theme')"), '主题选择要持久化');
  const head = html.slice(0, html.indexOf('<style>'));
  assert.ok(head.includes("setAttribute('data-theme'"), '内联脚本必须在 style 之前落主题，否则刷新会闪一下另一套');
});

test('CSS 颜色必须全部走令牌，令牌块之外不许有硬编码色值', () => {
  const html = readHomepage();
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const offenders = css.split('\n')
    .map((l, i) => ({ l: l.trim(), i: i + 1 }))
    .filter(x => /#[0-9A-Fa-f]{3,8}\b/.test(x.l) && !x.l.startsWith('--'));
  assert.deepStrictEqual(offenders, [], '这些行绕过了令牌，切到暗色时会不跟随：' + JSON.stringify(offenders.slice(0, 5)));
});

test('配置高亮：不得在自身生成的标签上二次着色', () => {
  const html = readHomepage();
  const from = html.indexOf('function highlightConfig');
  const src = html.slice(from, html.indexOf('function renderConfig', from));
  assert.ok(from > -1 && src.length > 80, '应能截到 highlightConfig 函数体');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fn = new Function('esc', src + '; return highlightConfig;')(esc);
  const out = fn([
    '# Dify · 模型供应商配置',
    '模型名称: deepseek-chat',
    'API base: https://api.deepseek.com',
    'ANTHROPIC_BASE_URL=https://api.anthropic.com',
    'https://bare-url.example/path'
  ].join('\n'));
  assert.ok(!/"[kcs]">/.test(out.replace(/<[^>]*>/g, '')),
    '剥掉标签后的正文里不该残留 class 片段（旧实现就是这样把 "c"> 显示出来）');
  assert.ok(out.includes('https://api.deepseek.com'), 'URL 必须完整不被当注释截走');
  assert.ok(out.includes('<span class="c"># Dify'), '整行注释仍要着色');
  assert.ok(out.includes('<span class="k">模型名称</span>'), '中文键名要能识别');
  assert.ok(out.includes('<span class="s">https://api.anthropic.com</span>'), '.env 的 = 值要着色');
  assert.ok(!out.includes('<span class="k">https</span>'), '裸 URL 行不该被拆成键值对');
});

test('CSS 变量不得有悬空引用（改令牌名时最容易漏）', () => {
  const html = readHomepage();
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  const used = new Set([...html.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
  const dangling = [...used].filter(t => !defined.has(t));
  assert.deepStrictEqual(dangling, [], '这些 var() 引用没有对应定义，浏览器会静默失效：' + dangling);
});

test('双列是开关：属性、按钮、持久化与栅格规则齐备', () => {
  const html = readHomepage();
  assert.ok(html.includes(':root[data-cols="2"] .board'), '双列应挂在 #board 上，挂在 .group 上等于把单卡压窄');
  assert.ok(/:root\[data-cols="2"\] \.board \{[^}]*columns:\s*2/.test(html),
    '两列要用多列流。grid 按行对齐，一组 3 张卡挨着一组 1 张卡时，矮的那侧会空出一整行');
  assert.ok(/:root\[data-cols="2"\] \.group[^{]*\{[^}]*break-inside:\s*avoid/.test(html),
    '组不许被劈成两半，否则平台标题会和它的卡片分落到两列');
  assert.ok(html.includes('id="btn-cols"'), '顶栏要有双列开关');
  assert.ok(html.includes("localStorage.getItem('aegis-cols')"), '列数选择要持久化');
  assert.ok(html.slice(0, html.indexOf('<style>')).includes("setAttribute('data-cols'"),
    'data-cols 必须在 style 之前落好，否则首屏先单列再跳两列');
  assert.ok(html.includes('@media (max-width: 1100px)'), '窄屏要把双列降回单列');
});

test('卡片脚注合并成一行，端点命名统一且按钮不再单字', () => {
  const html = readHomepage();
  assert.ok(!html.includes('class="kc-l2"'), 'kc-l2 那行只放两个右对齐按钮，是空洞的来源');
  assert.ok(!html.includes('.assigned-row'), '已配置到不再独占一行');
  assert.ok(html.includes("'<div class=\"kc-foot\">'"), '去向与动作应在同一行左右分开');
  assert.ok(html.includes("'<span class=\"lbl2\">端点 ' + (i + 1) + '</span>'"), '端点标签统一为「端点 N」');
  assert.ok(!html.includes("'地址 ' + (i + 1)"), '不该再有 Base URL / 地址 2 两套叫法');
  assert.ok(html.includes('>测这条</button>') && html.includes('>拉模型</button>'), '端点按钮要说清动作');
  assert.ok(!html.includes('data-act="ep-test" data-idx="\' + i + \'" title="只测这条端点">测<'), '单字「测」应已替换');
  assert.ok(html.includes('statCell('), '统计数字应走统一渲染，0 不染色');
});

test('表单校验：Key 的必填报错必须贴着 Key 输入框，不在按钮旁', () => {
  const html = readHomepage();
  const field = html.slice(html.indexOf('<div class="field span2">'), html.indexOf('id="endpoints-box"'));
  assert.ok(field.includes('id="key-err"'), 'key-err 应在 API Key 那个 field 内部');
  assert.ok(field.indexOf('id="f-key"') < field.indexOf('id="key-err"'), '错误位应排在输入框之后');
  assert.ok(html.includes("keyErr.textContent = 'API Key 为必填项'"),
    '必填报错要写进就近槽，而不是弹窗底部那个通用的 name-err');
  assert.ok(html.includes(".name-err.inline:empty { display: none; }"),
    '就近槽空着时不能占位，否则表单凭空多一行空隙');
});

test('手动添加的模型必须立刻出现在清单里，不被"尚未拉取"盖住', () => {
  const html = readHomepage();
  const at = html.indexOf('} else if (!models.length) {');
  assert.ok(at > -1, '应存在模型清单分支');
  const seg = html.slice(at, at + 320);
  assert.ok(seg.includes('k.modelsFetched'), '空状态要按 modelsFetched 分两种文案');
  const before = html.slice(0, at);
  assert.ok(!/else if \(!k\.modelsFetched\) \{/.test(before.slice(before.indexOf('function renderDrawer'))),
    '不能再有"只看 modelsFetched 就出空状态"的分支，那会藏掉手动添加的模型');
});

test('品牌：标识与主色对齐 logo，且内联版与 vendor 版几何一致', () => {
  const html = readHomepage();
  const brand = path.join(__dirname, '..', 'public', 'vendor', 'brand', 'aegislens-icon.svg');
  assert.ok(fs.existsSync(brand), 'vendor 里要有独立可用的标识文件');
  const svg = fs.readFileSync(brand, 'utf8');

  // 必须限定在 logo 那一段里取：全文第一个 d="..." 会被图标 sprite 抢先命中，
  // 那样比的是「i-activity 的路径」和「vendor 标识」，断言的名字和内容就对不上了
  const logoBlock = (html.match(/<svg class="logo"[\s\S]*?<\/svg>/) || [])[0];
  assert.ok(logoBlock, '找不到顶栏内联标识 <svg class="logo">');
  const dOf = s => (s.match(/d="([^"]+)"/) || [])[1];
  assert.ok(dOf(logoBlock) && dOf(svg), '两处都该有 path d');
  assert.strictEqual(dOf(logoBlock), dOf(svg),
    '顶栏内联标识与 vendor 文件的路径数据必须一致，否则会各自漂移');

  assert.ok(html.includes('<svg class="logo"'), '顶栏应内联 SVG 标识');
  assert.ok(!html.includes('<div class="logo">K</div>'),
    '改名前遗留的字母 K 标识应已被替换');
  assert.ok(/<link rel="icon"[^>]+\/vendor\/brand\//.test(html),
    'favicon 应指向本地 vendor，不许外链');
  assert.ok(html.includes('--accent: #3E3BC8'), '浅色主色对齐 logo 实测色');
  assert.ok(html.includes('--accent: #8B85EE'), '深色主色为 logo 色的提亮版');
  assert.ok(!/rgba\(75, 63, 227/.test(html) && !html.includes('#4B3FE3') && !html.includes('#7C6FF5'),
    '旧主色的派生 rgba 也要一并换掉，否则软底和描边会留着上一个颜色');
});

test('模型来源标签：后端每个 src 值都要有显式出口，兜底不许冒充数据源', () => {
  const html = readHomepage();
  const from = html.indexOf('var SRC_LABEL = {');
  assert.ok(from > -1, 'SRC_LABEL 映射应存在');
  const block = html.slice(from, html.indexOf('var SRC_CLS'));
  const keys = [...block.matchAll(/(\w+):\s*'[^']+'/g)].map(m => m[1]);

  // 后端 src 值的产生点分散在 src: / ctxSrc: / outSrc: 与三元表达式里，
  // 用正则从赋值点自动收集不可靠（ctxSrc: x !== null ? 'api' : null 这种根本抓不到）。
  // 所以这里显式列出期望集，再逐个断言它在后端源码里仍作为字面量存在：
  // 改名漂移会立刻报，但它不等于穷尽覆盖，新增值仍要靠人把名字加进这张表。
  const EXPECTED = ['api', 'meta', 'web', 'manual', 'builtin', 'unknown'];
  const srcDir = path.join(__dirname, '..', 'src');
  const allSrc = fs.readdirSync(srcDir).filter(x => x.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n');
  for (const v of EXPECTED) {
    assert.ok(allSrc.includes("'" + v + "'"),
      '期望的 src 值 ' + v + ' 在后端源码里已找不到字面量，可能已被改名或删除，' +
      '请同步前端 SRC_LABEL');
  }
  const missing = EXPECTED.filter(v => !keys.includes(v));
  assert.deepStrictEqual(missing, [],
    '这些 src 值没有显式标签，会掉进兜底被误标：' + missing);

  assert.ok(!/m\.src === 'builtin' \? '官方目录' : '元数据库'/.test(html),
    '旧的"兜底即元数据库"写法应已被替换');
  assert.ok(html.includes("'未识别来源 '"), '未识别值应原样显示而不是归类');
  assert.ok(/\.m-tag\.unknown\s*\{[^}]*dashed/.test(html),
    'unknown 要有可辨识的虚线样式，不能和正常来源长得一样');
});

test('入场动效不许把内容藏没：默认态可见，开关由 JS 加', () => {
  const html = readHomepage();
  assert.ok(!/<main class="board[^"]*(first-paint|rise-in)/.test(html),
    'HTML 里不能预置入场类名，否则动画不跑（后台标签页、无头渲染）时卡片会停在 opacity:0');
  assert.ok(html.includes("classList.add('rise-in')"), '类名应由 JS 在 render() 之后加');
  const at = html.indexOf('.board.rise-in .keycard');
  assert.ok(at > -1 && /animation:\s*rise[^;]*backwards/.test(html.slice(at, at + 120)),
    '有 JS 兜底之后，backwards 才是安全的');
});

test('字阶：层级阶梯比值要达标，注释不许替代码撒谎', () => {
  const html = readHomepage();
  const m = html.match(/--fs-xs:\s*([\d.]+)px;\s*--fs-sm:\s*([\d.]+)px;\s*--fs-base:\s*([\d.]+)px;\s*--fs-lg:\s*([\d.]+)px;\s*--fs-xl:\s*([\d.]+)px/);
  assert.ok(m, '应能解析五档字号');
  const v = m.slice(1).map(Number);
  assert.ok(v[3] / v[2] >= 1.25, 'base→lg 应 >= 1.25，实测 ' + (v[3] / v[2]).toFixed(3));
  assert.ok(v[4] / v[3] >= 1.25, 'lg→xl 应 >= 1.25，实测 ' + (v[4] / v[3]).toFixed(3));
  assert.ok(!/相邻档差\s*>=\s*1\.18/.test(html),
    '旧注释声称相邻档差 >= 1.18，实测三档只有 1.12~1.14，属于注释撒谎');
});

test('端点兼容模式：界面给可读标签，自定义值必须能原样存回', () => {
  const html = readHomepage();
  assert.ok(!html.includes('list="style-list"'), '不该再留裸文本框让人手打 openai/anthropic');
  assert.ok(html.includes('<select class="ep-style"'), '兼容模式应是下拉');
  assert.ok(/sel\.value === '__custom'[\s\S]{0,140}ep-style-custom'\)\.value\.trim\(\)/.test(html),
    '收集时必须取自定义框的值，否则自定义兼容名会被静默丢掉');
  assert.ok(html.includes("custom.value = style || ''"), '编辑已有的自定义端点时自定义框要回填');
  assert.ok(/custom\.style\.display = sel\.value === '__custom'/.test(html),
    '只有选自定义才该出现输入框，否则每行都挂一个空框');
});

test('内联脚本必须能通过语法解析，且 addEpRow 要自己造出行元素', () => {
  const html = readHomepage();
  // 页面里有两段 <script>：head 里的主题预置，和 body 末尾的主脚本。取最长那段。
  const body = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]).sort((a, b) => b.length - a.length)[0];
  assert.ok(body && body.length > 20000, '应截到主脚本主体，实际 ' + (body || '').length);
  try { new Function(body); }
  catch (e) { assert.fail('内联脚本语法不过：' + e.message); }

  const at = html.indexOf('function addEpRow(url, style) {');
  const fn = html.slice(at, html.indexOf('function ', at + 10));
  assert.ok(/var row = document\.createElement\('div'\)/.test(fn),
    'addEpRow 必须自己 createElement。上一轮改动把这一行挤掉了，' +
    '结果 row 未定义、整个表单的端点行渲染不出来，而字符串断言全绿。');
});

test('epStyleOptions 产出的属性必须能被浏览器正确解析', () => {
  const html = readHomepage();
  const at = html.indexOf('var EP_STYLE_KNOWN');
  const src = html.slice(at, html.indexOf('function addEpRow', at));
  const fn = new Function(src + '; return epStyleOptions;')();
  const onAnthropic = fn('anthropic');
  assert.ok(/<option value="anthropic" selected>/.test(onAnthropic),
    '选中项要生成合法属性。上一轮多打了一个引号变成 selected"="">，浏览器不认，' +
    '所有下拉退回第一项 openai，保存时把 anthropic 端点静默覆盖掉了');
  assert.ok(!/selected"/.test(onAnthropic), '不许出现 selected" 这种断裂属性');
  assert.ok(/<option value="__custom">/.test(onAnthropic), '已知值时自定义项不该被选中');
  assert.ok(/<option value="__custom" selected>/.test(fn('mycompat')), '未知值必须落到自定义项');
});

test('标识两版：顶栏六片叶、favicon 简化版，同盾牌不同复杂度', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'brand', f), 'utf8');
  const full = read('aegislens-icon.svg'), small = read('aegislens-favicon.svg');
  const subs = s => ((s.match(/d="[^"]*"/)[0].match(/Z/g) || []).length);
  assert.strictEqual(subs(full), 8, '原版 = 盾牌 2 环 + 6 片叶');
  assert.strictEqual(subs(small), 4, '简化版 = 盾牌 2 环 + 实心盘 + 六边形孔');
  assert.strictEqual(full.match(/viewBox="([^"]+)"/)[1], small.match(/viewBox="([^"]+)"/)[1],
    '两版 viewBox 必须一致，否则换 favicon 时尺寸会跳');
  assert.ok(readHomepage().includes('/vendor/brand/aegislens-favicon.svg'), 'favicon 应指向简化版');
  assert.ok(/prefers-color-scheme:\s*dark/.test(small),
    '独立 SVG 当 favicon 时 currentColor 不生效，必须自带深浅两色');
});

test('P0 回归：窄屏不许再拿 URL 换按钮，收缩压力不得全落在 URL 上', () => {
  const html = readHomepage();
  assert.ok(/\.param\.url \.val \{[^}]*min-width:\s*14ch/.test(html),
    '端点 URL 要有 14ch 下限。上一轮 .val 是 min-width:0，成了唯一可压缩项，' +
    '420px 下 https://api.deepseek.com/anthropic 只剩 18%');
  assert.ok(/\.ep-acts \{[^}]*flex-shrink:\s*0/.test(html),
    '动作按钮要成组且不可压缩，整组换行而不是把 URL 挤没');
  assert.ok(/\.param \{[^}]*flex-wrap:\s*wrap/.test(html), '.param 必须允许换行');
  assert.ok(/\.param\.key \.val \{[^}]*flex:\s*0 0 auto/.test(html),
    'Key 不许截断：省略号切掉尾巴，而尾巴正是自动命名唯一的识别点');
  const markup = html.slice(html.indexOf("'<span class=\"param url\""), html.indexOf("'<span class=\"param url\"") + 900);
  assert.ok(markup.includes('class="ep-acts"'), '端点三个按钮要包在 .ep-acts 里');
});

test('代码面与图标：浅色主题下不许再贴一块深色终端，图标不许用 emoji', () => {
  const html = readHomepage();
  const lightBlock = html.slice(0, html.indexOf(':root[data-theme="dark"]'));
  assert.ok(/--code-bg:\s*#EDEFF5/.test(lightBlock),
    '浅色的 code-bg 必须是浅面。原先两套主题共用 #141623，浅色弹窗里像另一套主题没跟上');
  const darkBlock = html.slice(html.indexOf(':root[data-theme="dark"]'));
  assert.ok(/--code-bg:\s*#232833/.test(darkBlock) && /--code-k:\s*#7FE0B4/.test(darkBlock),
    '深色侧要显式拿回为深底调的亮语法色，否则会继承浅色的深字配色');
  assert.ok(!/🙈|👁/.test(html), '显示/隐藏明文改用内联 SVG，emoji 跨字体渲染不一致');
  assert.ok(/function eyeIcon\(revealed\)/.test(html) && /aria-label="' \+ \(revealed \? '隐藏明文'/.test(html),
    'SVG 图标要 aria-hidden 且按钮自带 aria-label');
});

test('模型能力位与按字段来源：七个已持久化字段都要有出口，且不许挤坏数值行', () => {
  const html = readHomepage();
  const at = html.indexOf('var SRC_LABEL');
  const src = html.slice(at, html.indexOf('function maskKey', at));
  assert.ok(at > -1 && src.length > 1200, '应能截到来源/能力位这一整段助手函数');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const F = new Function('esc', src + '; return { fieldSrcs: fieldSrcs, srcChips: srcChips, capChips: capChips, warnChips: warnChips };')(esc);

  // 1) 同一字段的两个来源不同 -> 必须拆成两条，不能压成一个「平台接口」
  const split = F.srcChips({ ctx: 100, out: 200, ctxSrc: 'api', outSrc: 'web', src: 'api' });
  assert.ok(split.includes('上下文 · 接口') && split.includes('输出 · 联网'),
    'ctxSrc=api / outSrc=web 时要把两个出处分别标出来，实得：' + split);
  assert.ok(split.includes('m-tag api split') && split.includes('m-tag web split'), '拆分标签要各自带来源色');

  // 2) 两字段同源 -> 只留一条聚合标签，别每行挂两个重复标签
  const same = F.srcChips({ ctx: 100, out: 200, ctxSrc: 'api', outSrc: 'api', src: 'api' });
  assert.strictEqual((same.match(/class="m-tag/g) || []).length, 1, '同源时只有一条标签：' + same);
  assert.ok(same.includes('平台接口') && !same.includes('split'));

  // 3) 旧记录只有整条 src，没有 ctxSrc/outSrc -> 按同源理解，不许退化成「参数未取到」
  assert.deepEqual(F.fieldSrcs({ ctx: 8, out: 8, src: 'web' }), { ctxSrc: 'web', outSrc: 'web' });
  assert.ok(F.srcChips({ ctx: 8, out: 8, src: 'web' }).includes('联网检索'));
  assert.deepEqual(F.fieldSrcs({ ctx: null, out: null, src: 'unknown' }), { ctxSrc: null, outSrc: null },
    '值没取到时不许把 unknown 当作有来源');

  // 3b) src=manual 分两种（PATCH 自 033dd1d 起会把改过的字段写成 manual）：
  //     两个字段来源都不是 manual = 修复前的存量脏行，只能按整条标签走
  const stale = F.srcChips({ ctx: 4096, out: 2048, src: 'manual', ctxSrc: 'api', outSrc: 'api' });
  assert.ok(stale.includes('手动填写') && !stale.includes('split'),
    '脏行不许采用过期的按字段来源，否则把人手填的值标成平台报的：' + stale);
  assert.ok(F.srcChips({ ctx: 4096, out: 2048, src: 'manual' }).includes('手动填写'),
    'POST 新建的手动行没有按字段来源，走 legacy 兜底');
  //     有一个字段是 manual = 修复后写的，另一个字段的真实来源要照实拆出来
  const mixed = F.srcChips({ ctx: 4096, out: 2048, src: 'manual', ctxSrc: 'manual', outSrc: 'api' });
  assert.ok(mixed.includes('上下文 · 手动') && mixed.includes('输出 · 接口'),
    '只手改 ctx 时，out 仍是平台报的，必须拆成两条而不是整条标成手动填写：' + mixed);

  // 4) 能力位：默认态（纯文本 / 无推理数据）不许制造噪声
  assert.strictEqual(F.capChips({ modalitiesIn: ['text'] }), '', '纯文本是默认，不该每行都喊一遍');
  assert.ok(F.capChips({ reasoning: true }).includes('支持推理'));
  assert.ok(F.capChips({ reasoning: false }).includes('不支持推理') && F.capChips({ reasoning: false }).includes('off'));
  assert.ok(F.capChips({ modalitiesIn: ['text', 'image'] }).includes('输入含 图片'));
  assert.ok(F.capChips({ modalitiesIn: ['text', 'pdf'] }).includes('pdf'), '未登记的模态要原样吐出来');
  assert.ok(F.capChips({ rpm: 180 }).includes('180 次/分钟'));
  assert.strictEqual(F.capChips({ rpm: 0 }), '', '0 次/分钟不是限速信息');

  // 5) 两个不一致标记走告警色，而不是混进普通能力位
  assert.ok(F.warnChips({ conflict: true }).includes('接口与内置表不一致'));
  assert.ok(F.warnChips({ outGtCtx: true }).includes('输出上限大于上下文'));
  assert.strictEqual(F.warnChips({ conflict: false, outGtCtx: false }), '');
  // 5b) 结论必须在可见文案里，不能只活在 title —— 这两颗是非聚焦 span，键盘和触屏碰不到 title
  const seen = (h) => h.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
  assert.ok(/取接口值/.test(seen(F.warnChips({ conflict: true }))),
    '「已采用哪个值」是看到不一致后的第一个问题，只写在 title 里等于对一半用户不存在');
  assert.ok(/疑含思考链/.test(seen(F.warnChips({ outGtCtx: true }))), 'outGtCtx 的成因要可见，不能只靠悬停');

  // 6) 出口真的接进 DOM：三个函数都必须在 renderModelRow 里被调用
  const row = html.slice(html.indexOf('function renderModelRow'), html.indexOf('function manualSection'));
  for (const name of ['srcChips(m)', 'capChips(m)', 'warnChips(m)']) {
    assert.ok(row.includes(name), 'renderModelRow 没调用 ' + name);
  }
  for (const f of ['ctxSrc', 'outSrc', 'conflict', 'outGtCtx', 'reasoning', 'modalitiesIn', 'rpm']) {
    assert.ok(src.includes('m.' + f), '字段 ' + f + ' 在渲染层没有任何读取');
  }

  // 7) 收缩压力只许落在模型 ID 上：数值胶囊整颗换行，不许被压扁（C 线 P0 的同一个坑）
  assert.ok(/\.model-item \.param:not\(\.mid-param\) \{ flex-shrink: 0/.test(html),
    '数值胶囊必须 flex-shrink:0，否则能力位一多就轮到"上下文 1024K"被挤掉字');
  assert.ok(/\.m-extra\s*\{[^}]*flex-wrap:\s*wrap/.test(html), '.m-extra 要能整体换行');
  assert.ok(/\.m-cap\s*\{[^}]*border:/.test(html), '能力位用描边而不是实心底色，避免和来源标签抢层级');
});

test('弹层与提示的键盘/读屏出口：焦点要进得去、出得来、Tab 出不去', () => {
  const html = readHomepage();

  // 1) 每个弹窗都要是可识别的模态。数量不写死 —— 这条断言归结构，别线加弹窗不该让它红
  const overlays = [...html.matchAll(/<div class="modal"([^>]*)>/g)].map(m => m[1]);
  assert.ok(overlays.length >= 4, '至少要有 4 个 .modal 面板，实得 ' + overlays.length);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  overlays.forEach((attrs, i) => {
    assert.ok(/role="dialog"/.test(attrs), '第 ' + (i + 1) + ' 个弹窗缺 role=dialog');
    assert.ok(/aria-modal="true"/.test(attrs), '第 ' + (i + 1) + ' 个弹窗缺 aria-modal');
    assert.ok(/tabindex="-1"/.test(attrs), '第 ' + (i + 1) + ' 个弹窗缺 tabindex=-1，无法程序化聚焦');
    const id = (attrs.match(/aria-labelledby="([^"]+)"/) || [])[1];
    assert.ok(id && ids.includes(id), '第 ' + (i + 1) + ' 个弹窗的 aria-labelledby 指向了不存在的 id：' + id);
  });

  // 2) 提示条要有活区，否则「已复制」「测试失败」对读屏完全静默
  assert.ok(/id="toasts"[^>]*aria-live="polite"/.test(html), '#toasts 必须 aria-live');

  // 3) 开弹窗把焦点送进去、关弹窗还回来，且归还点脱离文档时不硬 focus
  const open = html.slice(html.indexOf('function openOverlay'), html.indexOf('function closeOverlay'));
  assert.ok(/overlayReturnFocus = document\.activeElement/.test(open), '要记归还点');
  assert.ok(/if \(!wasOpen\)/.test(open), '弹窗之间切换时不许覆盖最初的归还点');
  assert.ok(/panel\.focus\(\)/.test(open), '开弹窗必须把焦点送进面板');
  const close = html.slice(html.indexOf('function closeOverlay'), html.indexOf("querySelectorAll('[data-close]')"));
  assert.ok(/document\.contains\(back\)/.test(close), '看板重渲染后归还点是脱离文档的旧节点，focus() 会静默无效，必须先判');
  assert.ok(/if \(document\.querySelector\('\.overlay\.show'\)\) return/.test(close), '还有弹窗开着时不该抢焦点');

  // 4) Tab 必须被关在当前弹窗里
  const kb = html.slice(html.indexOf('var FOCUSABLE'), html.indexOf('/* ================= 启动'));
  assert.ok(/FOCUSABLE/.test(kb) && /ev\.key !== 'Tab'/.test(kb), 'keydown 里要有 Tab 环绕');
  assert.ok(/ev\.preventDefault\(\)/.test(kb), '环绕到首尾要阻止默认');
  assert.ok(/!ov\.contains\(cur\)/.test(kb), '焦点还在弹窗外时要先拉回来');

  // 5) 关闭路径只能走 closeOverlay，否则 ESC / 遮罩关闭不还焦点
  const raw = [...html.matchAll(/classList\.remove\('show'\)/g)].length;
  assert.strictEqual(raw, 2, '裸关只允许 openOverlay 的互斥清理与 closeOverlay 自己，实得 ' + raw + ' 处');
  assert.ok(/closeOverlay\(ov\.id\)/.test(kb), 'ESC 必须走 closeOverlay 才会归还焦点');
  assert.ok(/closeOverlay\(btn\.dataset\.close\)/.test(html), '关闭按钮走 data-close');
  assert.ok(/closeOverlay\(ov\.id\)/.test(html.slice(html.indexOf(".querySelectorAll('.overlay')"))), '点遮罩关闭也要走 closeOverlay');
});

test('默认模型那一行要一眼认得出：实色描边 + 状态徽标，不许退回灰掉的禁用按钮', () => {
  const html = readHomepage();
  assert.ok(/\.model-item\.default\s*\{\s*border-color:\s*var\(--accent\)/.test(html),
    '默认行描边必须用实色 --accent。上一版用 --accent-line（浅色只有 30% 透明），浅色下几乎看不出哪行是当前默认');
  assert.ok(/\.m-default\s*\{[^}]*border:\s*1px solid var\(--accent\)/.test(html), '徽标要自带实色描边');
  assert.ok(!/disabled[^>]*>当前默认/.test(html),
    '「当前默认」是状态不是按钮，渲染成 disabled 会被读成"点不动的按钮"而不是"这行是默认"');
  assert.ok(/<span class="m-default">当前默认<\/span>/.test(html), '要用 span 徽标');
});

test('图标 sprite：每个 ic() 引用都要有对应 symbol，许可证随仓且不许外链', () => {
  const html = readHomepage();
  const vendor = path.join(__dirname, '..', 'public', 'vendor', 'icons');
  assert.ok(fs.existsSync(path.join(vendor, 'LICENSE-ISC.txt')), 'Lucide 的 ISC 许可证必须随仓');
  assert.ok(fs.existsSync(path.join(vendor, 'CREDITS.md')), '要写明来源仓库、commit SHA 与命名替换');

  const symbols = new Set([...html.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map(m => m[1]));
  assert.ok(symbols.size >= 30, 'sprite 应已内联，实得 ' + symbols.size + ' 个 symbol');
  // 取 ic() 里所有字面量名，三元形式（ic(dark ? 'moon' : 'sun')）也要算进来
  const used = [...new Set([...html.matchAll(/\bic\(([^)]*)\)/g)]
    .flatMap(call => [...call[1].matchAll(/'([a-z0-9-]+)'/g)].map(q => q[1])))];
  assert.ok(used.length >= 6, '至少要有 6 个图标名在被引用，实得 ' + used.length + '：' + used.join(','));
  const missing = used.filter(n => !symbols.has(n));
  assert.deepStrictEqual(missing, [], '这些 ic() 名字没有对应 symbol，会静默画成空白：' + missing.join(', '));

  // 呈现属性必须由引用处给：display:none 的容器不往 <use> 实例传递
  assert.ok(/function ic\(name, size\)/.test(html) && /\.ic\s*\{/.test(html), '要有统一的 ic() 与 .ic 样式');
  const icBody = html.slice(html.indexOf('function ic(name, size)'), html.indexOf('function eyeIcon'));
  for (const attr of ['stroke="currentColor"', 'fill="none"', 'stroke-width="1.5"', 'aria-hidden="true"']) {
    assert.ok(icBody.includes(attr), 'ic() 必须自带 ' + attr + '，否则图标不显示或读屏会念');
  }
  assert.ok(!/<use[^>]+href="https?:/.test(html) && !/url\(https?:[^)]*\.svg/.test(html),
    '图标不许外链，必须内联或走本地 /vendor/');
  // 被当图标用的 Unicode/emoji 不能回来
  assert.ok(!/[\u2600\u263E\u25A4\u25A6]/.test(html), '☀☾▤ 已由 sprite 取代，不许退回 Unicode');
});
