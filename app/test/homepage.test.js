'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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
    (html.match(/https:\/\/github\.com\/roseion\/ai-key-manager/g) || []).length >= 3,
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
