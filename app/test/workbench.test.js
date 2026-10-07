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
