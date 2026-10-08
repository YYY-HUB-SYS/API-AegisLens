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
  assert.ok(html.includes('repeat(2, minmax(0, 1fr))'), '两列要用 minmax(0,1fr) 才允许收缩');
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

  const dOf = s => (s.match(/d="([^"]+)"/) || [])[1];
  assert.ok(dOf(html) && dOf(svg), '两处都该有 path d');
  assert.strictEqual(dOf(html), dOf(svg),
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
