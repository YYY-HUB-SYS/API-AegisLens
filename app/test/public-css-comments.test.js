/* 公共样式表的注释卫生守卫。
   consumer-view.css 头部注释的 token 清单里曾混入一个「星号+斜杠」序列，
   它提前闭合了注释：从那个位置到下一个分号之间的所有内容
   （包括 .cvw-root 这一整块设计令牌）被 CSS 解析器当垃圾吞掉，
   消费者视图一度全靠继承色渲染（面板透明、按钮方角、标题塌成 14px）。
   这种病 JS 不报、Node 测试看不见，只有浏览器里才现形，
   于是用注释状态机扫：注释外出现该序列、或注释到文件尾不闭合，都 fail。 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sources = [
  ['index.html 内联样式', path.join(__dirname, '..', 'public', 'index.html')],
  ['credentials-view.css', path.join(__dirname, '..', 'public', 'credentials-view.css')],
  ['consumer-view.css', path.join(__dirname, '..', 'public', 'consumer-view.css')],
];

function scan(css) {
  const stray = [];
  let inComment = false;
  let line = 1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '\n') { line++; continue; }
    if (!inComment && c === '/' && css[i + 1] === '*') { inComment = true; i++; continue; }
    if (inComment && c === '*' && css[i + 1] === '/') { inComment = false; i++; continue; }
    if (!inComment && c === '*' && css[i + 1] === '/') { stray.push(line); i++; continue; }
  }
  return { stray, unclosed: inComment };
}

for (const [name, file] of sources) {
  test(name + '：注释不许提前闭合（注释外不得出现星号斜杠序列）', () => {
    const css = fs.readFileSync(file, 'utf8');
    const { stray, unclosed } = scan(css);
    assert.deepStrictEqual(stray, [],
      '注释外的星号斜杠序列会吞掉后续规则，出在第 ' + stray.join('、') + ' 行');
    assert.ok(!unclosed, '注释未闭合：文件尾部还停在注释里');
  });
}
