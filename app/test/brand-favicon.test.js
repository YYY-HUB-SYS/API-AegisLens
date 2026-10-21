/* 品牌标识跟着皮肤走（三件事盯住）：
   1. 每套皮肤各有一版 favicon 与图标文件，填色就是那套皮肤的 --accent；
   2. 换皮只是换文件，几何一字不改（简版的几何有测试盯，不能漂）；
   3. index.html 真的按 data-skin 换 <link rel="icon"> 的 href。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const themeCss = require('./theme-css.js');

const BRAND_DIR = path.join(__dirname, '..', 'public', 'vendor', 'brand');
const read = f => fs.readFileSync(path.join(BRAND_DIR, f), 'utf8');

/* s1 用不带后缀的基准文件（默认皮肤），s2/s3 各带后缀 */
const FILES = {
  favicon: { s1: 'aegislens-favicon.svg', s2: 'aegislens-favicon-s2.svg', s3: 'aegislens-favicon-s3.svg' },
  icon: { s1: 'aegislens-icon.svg', s2: 'aegislens-icon-s2.svg', s3: 'aegislens-icon-s3.svg' }
};
/* 皮肤层重做之前那对旧主色。留在任何一个文件里都说明有人把旧色抄回来了。 */
const STALE = ['#3E3BC8', '#8B85EE', '#3e3bc8', '#8b85ee'];

function fills(svg) {
  const light = /path\{fill:(#[0-9A-Fa-f]{6})\}/.exec(svg);
  const dark = /prefers-color-scheme:dark\)\{path\{fill:(#[0-9A-Fa-f]{6})\}\}/.exec(svg);
  return {
    light: light ? light[1].toUpperCase() : null,
    dark: dark ? dark[1].toUpperCase() : null
  };
}
function geometry(svg) {
  return {
    d: (svg.match(/d="([^"]+)"/) || [])[1] || '',
    viewBox: (svg.match(/viewBox="([^"]+)"/) || [])[1] || ''
  };
}

test('每套皮肤都有自己那版 favicon 与图标文件，填色就是那套皮肤的主色', () => {
  const blocks = themeCss.skinBlocks();
  for (const skin of themeCss.SKINS) {
    for (const kind of ['favicon', 'icon']) {
      const file = FILES[kind][skin];
      const p = path.join(BRAND_DIR, file);
      assert.ok(fs.existsSync(p), skin + ' 的 ' + kind + ' 文件不在：' + file);
      const svg = fs.readFileSync(p, 'utf8');
      const f = fills(svg);
      const light = blocks.get(skin + '|light').vars.get('--accent').toUpperCase();
      const dark = blocks.get(skin + '|dark').vars.get('--accent').toUpperCase();
      assert.strictEqual(f.light, light, file + ' 的浅色填色不是 ' + skin + ' 的浅色主色');
      assert.strictEqual(f.dark, dark, file + ' 的深色填色不是 ' + skin + ' 的深色主色');
    }
  }
});

test('换皮只换颜色：各版的几何与基准文件逐字一致', () => {
  for (const kind of ['favicon', 'icon']) {
    const base = geometry(read(FILES[kind].s1));
    assert.ok(base.d && base.viewBox, kind + ' 基准文件里取不到几何');
    for (const skin of themeCss.SKINS) {
      const g = geometry(read(FILES[kind][skin]));
      assert.strictEqual(g.d, base.d, FILES[kind][skin] + ' 的路径与基准文件不一致（几何被改了）');
      assert.strictEqual(g.viewBox, base.viewBox, FILES[kind][skin] + ' 的 viewBox 与基准文件不一致');
    }
  }
});

test('旧主色不许留在任何一个品牌文件里', () => {
  for (const kind of ['favicon', 'icon']) {
    for (const skin of themeCss.SKINS) {
      const svg = read(FILES[kind][skin]);
      for (const stale of STALE) {
        assert.ok(!svg.includes(stale), FILES[kind][skin] + ' 里还有皮肤层重做前的旧主色 ' + stale);
      }
    }
  }
});

test('index.html 按 data-skin 换 favicon：映射全、启动就换、切皮肤也换', () => {
  const html = themeCss.readIndexHtml();
  assert.ok(/<link rel="icon"[^>]+href="\/vendor\/brand\/aegislens-favicon\.svg"/.test(html),
    '默认（s1）的 favicon 仍应指向基准文件');

  /* 映射表：三套皮肤各一条，且指向的文件都得真的存在 */
  const map = html.match(/var FAVICON_BY_SKIN = \{([\s\S]*?)\};/);
  assert.ok(map, '找不到 FAVICON_BY_SKIN 映射表');
  const entries = [...map[1].matchAll(/['"]?(s[123])['"]?\s*:\s*'([^']+)'/g)];
  assert.strictEqual(entries.length, 3, '映射表里应正好三条，实得 ' + entries.length);
  const seen = new Set();
  for (const [, skin, href] of entries) {
    seen.add(skin);
    assert.ok(href.startsWith('/vendor/brand/'), skin + ' 的 favicon 必须指向本地 vendor，不许外链');
    assert.ok(fs.existsSync(path.join(BRAND_DIR, path.basename(href))), skin + ' 的 favicon 文件不存在：' + href);
    const svg = fs.readFileSync(path.join(BRAND_DIR, path.basename(href)), 'utf8');
    const blocks = themeCss.skinBlocks();
    assert.strictEqual(fills(svg).light, blocks.get(skin + '|light').vars.get('--accent').toUpperCase(),
      skin + ' 的 favicon 文件与映射对不上');
  }
  assert.deepStrictEqual([...seen].sort(), themeCss.SKINS.slice().sort(), '映射表少了皮肤');

  /* 启动脚本：设完 data-skin 就换图标（否则会先闪一下旧色） */
  assert.ok(/applyFavicon\(sk\)/.test(html), '启动脚本应在设完 data-skin 后立刻换 favicon');
  /* 切皮肤时也要换 */
  const setSkin = html.match(/function setSkin\(v\) \{[\s\S]*?\n  \}/);
  assert.ok(setSkin, '找不到 setSkin');
  assert.ok(/AegisFavicon\.apply\(v\)/.test(setSkin[0]), 'setSkin 里必须同步换 favicon');
  /* URL 里带 ?skin= 的入口也得换 */
  assert.ok(/AegisFavicon\.apply\(qs\)/.test(html), '?skin= 直达入口必须同步换 favicon');
});
