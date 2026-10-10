/* 钉住一类反复出现的缺陷：把带文字的按钮塞进"只放图标"的固定盒，文字被裁成半截。
   触发点是用户 10-10 的截图——凭证卡「口令」那行的「显示」读起来像"目示"。
   量出来的硬数字：那个按钮 clientHeight=26、scrollHeight=34。 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'credentials-view.css'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'credentials-view.js'), 'utf8');

test('.cv-ghost-ico.with-label 必须按内容撑开，不能沿用图标的固定盒', () => {
  const rule = CSS.match(/\.cv-ghost-ico\.with-label\s*\{([^}]*)\}/);
  assert.ok(rule, '少了 .cv-ghost-ico.with-label 这条规则：带文字的按钮会退回 26×26 图标盒');
  assert.match(rule[1], /width:\s*auto/, '宽度要 auto，否则「显示」两个字放不下');
  assert.match(rule[1], /height:\s*auto/, '高度要 auto，否则第二行被裁成半截字');
});

test('渲染层里凡是「图标 + 文字」的 .cv-ghost-ico，都必须挂 with-label', () => {
  const re = /IC\.\w+\s*\+\s*'<span>/g;
  const sites = [];
  let m;
  while ((m = re.exec(JS))) {
    const back = JS.slice(Math.max(0, m.index - 300), m.index);
    const cls = back.match(/class="cv-ghost-ico[^"]*"/g);
    if (cls) sites.push(cls[cls.length - 1]);
  }
  assert.ok(sites.length >= 1, '没找到任何「图标 + 文字」的按钮渲染点，这条测试在空转');
  sites.forEach(function (s) {
    assert.ok(/with-label/.test(s), '有可见文字却没挂 with-label，会被图标盒裁掉半截：' + s);
  });
});
