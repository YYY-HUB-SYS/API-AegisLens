'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const homepagePath = path.join(__dirname, '..', '..', 'index.html');

function readHomepage() {
  return fs.readFileSync(homepagePath, 'utf8');
}

test('主页文件存在且结构完整', () => {
  assert.ok(fs.existsSync(homepagePath), 'index.html 应存在于仓库根目录');
  const html = readHomepage();
  assert.ok(html.length > 10000, '主页内容应足够充实');
  assert.match(html, /^<!DOCTYPE html>/i, '应以 <!DOCTYPE html> 开头');
  assert.match(html, /<\/html>\s*$/i, '应以 </html> 结尾');
  assert.match(html, /<html[^>]+lang="zh-CN"/, '应声明中文语言');
});

test('头部包含指向 www.oldgao.com 的「回到首页」链接', () => {
  const html = readHomepage();
  assert.ok(html.includes('回到首页'), '应包含「回到首页」文案');
  assert.match(html, /<a[^>]+href="https:\/\/www\.oldgao\.com"/, '回到首页应链接到 www.oldgao.com');
  assert.match(
    html, /<header[\s\S]{0,2000}?回到首页/,
    '「回到首页」链接应位于头部 header 内'
  );
});

test('包含 GitHub 仓库部署地址', () => {
  const html = readHomepage();
  assert.ok(
    (html.match(/https:\/\/github\.com\/YYY-HUB-SYS\/API-AegisLens/g) || []).length >= 3,
    'GitHub 仓库地址应多次出现（导航 / 快速开始 / 部署章节）'
  );
});

test('无外部资源引用（单文件自包含）', () => {
  const html = readHomepage();
  assert.doesNotMatch(html, /<script[^>]+\bsrc\s*=/i, '不应引用外部脚本');
  assert.doesNotMatch(html, /<link[^>]+href\s*=\s*["']?(https?:)?\/\//i, '不应引用外部样式表');
  assert.doesNotMatch(html, /<img[^>]+src\s*=\s*["']?(https?:)?\/\//i, '不应引用外部图片');
  assert.doesNotMatch(html, /@import/i, 'CSS 中不应使用 @import');
  assert.doesNotMatch(html, /url\(\s*["']?(https?:)?\/\//i, 'CSS 中不应引用外部资源');
  assert.doesNotMatch(html, /<iframe/i, '不应嵌入 iframe');
  assert.doesNotMatch(
    html, /fonts\.(googleapis|gstatic)\.com|cdn\./i,
    '不应引用 CDN 或在线字体'
  );
  const iconMatch = html.match(/<link[^>]+rel="icon"[^>]+href="([^"]+)"/i);
  if (iconMatch) {
    assert.match(iconMatch[1], /^data:/, '图标应使用 data URI 而非外部地址');
  }
});

test('声明浅色（非暗色）主题', () => {
  const html = readHomepage();
  assert.match(html, /<meta\s+name="color-scheme"\s+content="light">/, '应声明 color-scheme: light');
  assert.match(html, /--bg:\s*#f[0-9a-f]{5}/i, '页面背景应为浅色');
  assert.match(html, /color-scheme:\s*light/, 'CSS 应声明 color-scheme: light');
});

test('关键内容章节齐备', () => {
  const html = readHomepage();
  for (const keyword of [
    '功能特性', '安全设计', '支持平台', '使用流程', '快速开始', '获取与部署',
    'AES-256-GCM', '127.0.0.1', 'npm start', 'AKM_PORT', 'DEPLOYMENT.md',
  ]) {
    assert.ok(html.includes(keyword), `主页应包含关键内容：${keyword}`);
  }
});

test('内容与仓库事实一致', () => {
  const html = readHomepage();
  const catalog = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'platform-catalog.json'), 'utf8')
  );
  const builtIn = catalog.platforms.filter((p) => p.id !== 'custom');
  assert.strictEqual(builtIn.length, 13, '内置平台应为 13 个');
  for (const p of builtIn) {
    assert.ok(html.includes(p.name), `主页平台表格应包含：${p.name}`);
  }
  assert.ok(html.includes('oldgao.com'), '应包含作者个人主页');
});

/* 全局 `table { min-width: 720px }` 加网格项默认的 `min-width: auto`，两张表放一屏就足以把
   整页顶宽；`.table-wrap` 那个 overflow-x:auto 轮不到生效，因为容器自己先超了。
   真量过：390px 视口下页面横向溢出 91px（我往环境变量表里加了三行长文案之后是 230px），
   补上下面这条规则后四个宽度（390/600/900/1440）都是 0，表在自己框里滚。 */
test('窄屏：网格项要允许收缩，否则页面整体横向溢出', () => {
  const html = readHomepage();
  const rule = html.match(/\.start-grid > \*[^{]*\{\s*min-width:\s*0;?\s*\}/);
  assert.ok(rule, '缺了「网格项 min-width:0」那条规则：表多的那一屏会把整页顶宽');
  for (const grid of ['.deploy-grid', '.feature-grid', '.security-grid']) {
    assert.ok(rule[0].includes(grid), `${grid} 的网格项没跟着夹住：${rule[0]}`);
  }
  assert.ok(html.includes('.table-wrap { overflow-x: auto'), '表要能被夹住并自己滚');
});

/* 2026-10-12 翻过车：给 hero 加粒子时，补丁锚点撞上了页面里已有的 document.execCommand 那一行，
   整段 <script> 被注进了 fallbackCopy 的函数体中间。页面外壳看着正常，实际两块脚本都语法残废，
   粒子一个像素都没画——而当时所有静态断言（包含字符串、包含 class）全绿。
   所以这里不再只看「有没有这段文字」，而是把每个内联块真解析一遍。 */
test('每个内联 script 块要能独立解析，且标签配对', () => {
  const html = readHomepage();
  const opens = (html.match(/<script\b[^>]*>/gi) || []).filter(t => !/\bsrc\s*=/i.test(t));
  const closes = (html.match(/<\/script>/gi) || []).length;
  assert.strictEqual(closes, opens.length, `<script> 开 ${opens.length} 个、</script> 关 ${closes} 个，说明有一块被嵌进了另一块里面`);
  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1])
    .filter(body => body.trim().length > 0);
  assert.ok(blocks.length >= 2, `应至少解析出两段内联脚本，实际 ${blocks.length} 段`);
  blocks.forEach((body, i) => {
    assert.ok(!/<\/?script/i.test(body), `第 ${i} 段脚本正文里还嵌着 script 标签——就是那次翻车的形状`);
    try {
      new vm.Script(body, { filename: `homepage-inline-${i}.js` });
    } catch (e) {
      assert.fail(`第 ${i} 段内联脚本语法错误：${e.message}`);
    }
  });
});

test('hero 粒子画布：存在、在文字后面、不吃点击、且尊重 reduced-motion', () => {
  const html = readHomepage();
  assert.match(html, /<canvas class="hero-field"[^>]+aria-hidden="true"/, '要有一块 aria-hidden 的装饰画布');
  const css = html.match(/\.hero-field\s*\{[^}]*\}/);
  assert.ok(css, '缺 .hero-field 的定位规则');
  assert.match(css[0], /pointer-events:\s*none/, '画布盖满 hero，不禁点击会把标题和按钮的点击全吃掉');
  assert.match(css[0], /z-index:\s*0/, '画布要在正文之下');
  assert.match(html, /\.hero \.wrap[^{]*\{[^}]*z-index:\s*1/, '正文要抬到画布之上，否则文字被粒子糊住');

  const body = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
  assert.match(body, /prefers-reduced-motion/, '动效必须听系统的减少动效偏好');
  assert.match(body, /if \(!reduce\) raf = requestAnimationFrame/, '减少动效下不能续帧，只画一张静止图');
  assert.match(body, /document\.hidden/, '页面切到后台要停帧，不然空转耗电');
  assert.match(body, /cv\.width = Math\.round\(w \* dpr\)/, '位图尺寸要跟着 CSS 尺寸走，否则画出来是糊的（默认 300x150）');
});

