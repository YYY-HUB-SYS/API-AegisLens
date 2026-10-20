/* 皮肤层（app/public/app/theme.css）与接入层（app/public/index.html）的共用读取/解析件。
   界面重做后 CSS 变量从 index.html 的内联 <style> 搬到了 theme.css，
   6 组变量分别挂在 [data-skin="s1|s2|s3"][data-theme="dark|light"] 属性选择器下，
   "在 index.html 里抠出一块 :root { }" 这种找法已经失效。
   这个模块把两处 CSS 拼起来解析，并提供按皮肤/明暗取变量的入口。

   本文件不是测试（文件名不带 .test.js），只被 test/*.test.js 引用。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');
const THEME_PATH = path.join(PUBLIC_DIR, 'app', 'theme.css');
const CONTRACT_PATH = path.join(PUBLIC_DIR, 'app', 'CONTRACT.md');

const SKINS = ['s1', 's2', 's3'];
const THEMES = ['light', 'dark'];

function readIndexHtml() {
  return fs.readFileSync(INDEX_PATH, 'utf8');
}

function readThemeCss() {
  return fs.readFileSync(THEME_PATH, 'utf8');
}

function readContract() {
  return fs.readFileSync(CONTRACT_PATH, 'utf8');
}

/* index.html 里的内联 <style>（可能不止一块，全取出来拼一份）。 */
function inlineStyles(html) {
  const out = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out.join('\n');
}

/* 变量定义在 theme.css，用法（var(...)）在 index.html 与 theme.css 两边，
   缺一头就会把"引用了但没人定义"漏掉，所以凡是查变量都要看这份合并后的 CSS。 */
function mergedCss() {
  return inlineStyles(readIndexHtml()) + '\n' + readThemeCss();
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* 括号配平扫出每条规则的选择器与声明体。
   不能用正则硬切：index.html 的内联样式里有 @media 嵌套，
   @media 自己那段声明体里还包着内层规则，把内层的变量算到 @media 头上就会认错归属。 */
function parseRules(css) {
  const src = stripComments(css);
  const rules = [];
  const stack = [];
  let buf = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') {
      stack.push({ selector: buf.trim(), start: i + 1 });
      buf = '';
      i++;
    } else if (c === '}') {
      const top = stack.pop();
      if (top) rules.push({ selector: top.selector, body: src.slice(top.start, i) });
      buf = '';
      i++;
    } else {
      buf += c;
      i++;
    }
  }
  return rules;
}

/* 只取这条规则自己这一层的声明（剥掉嵌套子规则的内容）。 */
function ownDecls(body) {
  let out = '';
  let depth = 0;
  for (const c of body) {
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (depth === 0) out += c;
  }
  return out;
}

/* 一条规则里声明的自定义属性：名字 → 值。 */
function declarations(body) {
  const map = new Map();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;}]+)/g;
  let m;
  const text = ownDecls(body);
  while ((m = re.exec(text))) map.set(m[1], m[2].trim());
  return map;
}

/* theme.css 里的 6 组变量块，键是 "皮肤|明暗"（如 "s2|dark"）。 */
function skinBlocks() {
  const out = new Map();
  for (const rule of parseRules(readThemeCss())) {
    const m = rule.selector.match(/\[data-skin="(s[123])"\]\[data-theme="(light|dark)"\]/);
    if (!m) continue;
    out.set(m[1] + '|' + m[2], {
      skin: m[1],
      theme: m[2],
      selector: rule.selector,
      vars: declarations(rule.body)
    });
  }
  return out;
}

/* 十六进制色 → 相对亮度（WCAG 口径，0 最黑 1 最白）。
   用来判"这面是浅的还是深的"，免得把具体色值钉死在测试里，换一套皮肤就红。 */
function luminance(value) {
  if (value == null) return null;
  let h = String(value).trim();
  if (h[0] === '#') h = h.slice(1);
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const c = [0, 2, 4].map(i => {
    const s = parseInt(h.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/* CONTRACT 第二节列的变量名（直接读契约文件，不在这儿另抄一份）。
   只认 "--字母/数字" 开头的那种：契约里那条 markdown 分隔线 "---" 不是变量名。 */
function contractVars() {
  const md = readContract();
  const from = md.indexOf('## 二、变量清单');
  const to = md.indexOf('## 三、');
  if (from < 0) return [];
  const body = md.slice(from, to > from ? to : undefined);
  const out = [];
  const re = /(--[a-z0-9][a-z0-9-]*)/g;
  let m;
  while ((m = re.exec(body))) {
    if (out.indexOf(m[1]) < 0) out.push(m[1]);
  }
  return out;
}

/* 凭证区（--cv-*）与消费者区（--cvw-*）各有自己的令牌表，
   皮肤块把这两套也带上是为了那两个视图跟着皮肤走，
   不属于契约第二节的 AegisLens 令牌清单，检查时分开算。 */
const VIEW_TOKEN_PREFIXES = ['--cv-', '--cvw-'];

function isViewToken(name) {
  return VIEW_TOKEN_PREFIXES.some(p => name.indexOf(p) === 0);
}

module.exports = {
  SKINS: SKINS,
  THEMES: THEMES,
  readIndexHtml: readIndexHtml,
  readThemeCss: readThemeCss,
  readContract: readContract,
  inlineStyles: inlineStyles,
  mergedCss: mergedCss,
  parseRules: parseRules,
  ownDecls: ownDecls,
  declarations: declarations,
  skinBlocks: skinBlocks,
  luminance: luminance,
  contractVars: contractVars,
  isViewToken: isViewToken
};
