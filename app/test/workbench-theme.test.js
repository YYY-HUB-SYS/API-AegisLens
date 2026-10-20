/* 皮肤层（app/public/app/theme.css）与接入层（app/public/index.html）的契约守卫。
   界面重做把 CSS 变量搬出了 index.html 的内联 <style>，搬走之后不回潮的那几件事钉在这里：
   6 组皮肤令牌齐全、皮肤切换器在位、变量只在 theme.css 定义、渲染原子对布局层可见。

   布局口径：原先 4 套布局并存 + 一个「布局」切换器，已收敛成单视图
   （唯一那套 = window.BoardLayouts.main）。所以这里只认 3 个皮肤档，
   并且反向钉死两件事：界面里不得再冒出布局切换器、不得再引用 layout-a~d.js。 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const tc = require('./theme-css');

const CONTRACT_VARS = tc.contractVars();

test('皮肤层：3 皮肤 × 明暗 = 6 组选择器齐全', () => {
  const blocks = tc.skinBlocks();
  assert.strictEqual(blocks.size, 6,
    'theme.css 应有 6 组变量（3 皮肤 × 明暗两态），实得 ' + blocks.size);
  for (const skin of tc.SKINS) {
    for (const th of tc.THEMES) {
      const b = blocks.get(skin + '|' + th);
      assert.ok(b, '缺 ' + skin + ' × ' + th + ' 这一组');
      /* 皮肤块挂在属性选择器下（不再是 :root），少了属性就永远选不中 */
      assert.ok(b.selector.includes('[data-skin="' + skin + '"]') &&
        b.selector.includes('[data-theme="' + th + '"]'),
        skin + '/' + th + ' 的选择器应为属性选择器，实得 ' + b.selector);
    }
  }
});

test('皮肤层：每组都定义了 CONTRACT 第二节列出的全部变量', () => {
  assert.ok(CONTRACT_VARS.length >= 50,
    '没从 CONTRACT 第二节读到变量清单，实得 ' + CONTRACT_VARS.length + ' 个');
  const blocks = tc.skinBlocks();
  for (const [key, b] of blocks) {
    const missing = CONTRACT_VARS.filter(v => !b.vars.has(v));
    assert.deepStrictEqual(missing, [],
      key + ' 缺这些变量（契约第二节列了 ' + CONTRACT_VARS.length + ' 个）：' + missing.join(' '));
    /* 契约写明"只能用这些名"。凭证区（--cv-*）与消费者区（--cvw-*）是另外两张表，
       皮肤块带上它们是为了那两个视图跟着皮肤走，不算越界。 */
    const extra = [...b.vars.keys()]
      .filter(v => CONTRACT_VARS.indexOf(v) < 0 && !tc.isViewToken(v));
    assert.deepStrictEqual(extra, [],
      key + ' 定义了契约清单之外的自造变量名：' + extra.join(' '));
  }
});

test('皮肤切换器在位：3 个皮肤档（布局切换器已删，只剩单视图）', () => {
  const html = tc.readIndexHtml();
  for (const id of ['s1', 's2', 's3']) {
    assert.ok(new RegExp('<button[^>]*class="seg-btn"[^>]*data-skin="' + id + '"').test(html),
      '缺皮肤切换按钮 ' + id);
  }
  assert.ok(html.includes('.seg-btn[data-skin]'), 'JS 应按 .seg-btn[data-skin] 找皮肤按钮');
  assert.ok(html.includes("localStorage.getItem('aegis-skin')"), '皮肤选择要持久化');
  assert.ok(/function setSkin\(/.test(html), '应有 setSkin 入口');
  assert.ok(/setAttribute\('data-skin'/.test(html),
    '切换后要把属性写到 html 上，变量才切得过去');
});

test('界面里不得再有「布局」切换器：4 套布局已收敛成单视图', () => {
  /* 反向钉死。收敛之后每次打开都直接进主视图，不再有"先挑模式"这一步。
     只认代码形态：注释里残留的旧说法不算证据（别按字面去搜 "layout="）。 */
  const html = tc.readIndexHtml();
  assert.ok(!/data-layout/.test(html),
    'index.html 里不该再有 data-layout 属性（布局切换器已删）');
  assert.ok(!/\.seg-btn\[data-layout\]/.test(html),
    'JS 不该再按 .seg-btn[data-layout] 找布局按钮');
  assert.ok(!/function setLayout\(/.test(html),
    '不该再有 setLayout 入口');
  assert.ok(!/syncLayoutButtons/.test(html),
    '不该再有 syncLayoutButtons');
  assert.ok(!/localStorage\.getItem\('aegis-layout'\)/.test(html),
    '布局选择不该再持久化（没有多布局可选了）');
  assert.ok(!/setAttribute\('data-layout'/.test(html),
    '不该再往 html 上写 data-layout');
  assert.ok(!/\bstate\.layout\b/.test(html),
    'state.layout 字段应已删');
  assert.ok(!/get\(['"]layout['"]\)/.test(html),
    '?layout= URL 参数应已删（只剩 ?skin= / ?theme=）');
});

test('变量只在 theme.css 定义：index.html 不得再有 :root 变量块', () => {
  const html = tc.readIndexHtml();
  const inline = tc.inlineStyles(html);
  assert.ok(!/:root\s*\{/.test(inline),
    'index.html 内联样式里不该再有 :root { } 变量块，变量搬去 theme.css 了');
  assert.ok(!/(--[a-z0-9][a-z0-9-]*)\s*:/.test(inline),
    'index.html 内联样式里不该再定义任何自定义属性');
  assert.ok(/<link[^>]+href="\/app\/theme\.css"/.test(html),
    'index.html 要引 theme.css，否则皮肤层根本加载不到');
});

test('window.AegisUI 导出存在且含 renderCard', () => {
  const html = tc.readIndexHtml();
  assert.ok(/window\.AegisUI\s*=/.test(html), '应有 window.AegisUI 导出');
  /* 导出有两种写法都认：getter 形式（get renderCard() { return renderCard; }）
     与名单形式（['renderCard', ...].forEach(...)）。 */
  assert.ok(/get renderCard\(\)\s*\{\s*return renderCard;/.test(html) || /'renderCard'/.test(html),
    'window.AegisUI 里应导出 renderCard');
  assert.ok(/function renderCard\(/.test(html), '应定义 renderCard');
  /* CONTRACT 第一节把 LAYOUT_NAMES / SKIN_NAMES 都列为 AegisUI 的导出面，
     所以这张名表保留（它不是切换器；切换器已由上一条测试否掉）。 */
  assert.ok(/get LAYOUT_NAMES\(\)/.test(html) || /window\.AegisUI\.LAYOUT_NAMES\s*=/.test(html),
    '应导出 LAYOUT_NAMES');
  assert.ok(/get SKIN_NAMES\(\)/.test(html) || /window\.AegisUI\.SKIN_NAMES\s*=/.test(html),
    '应导出 SKIN_NAMES');
});

test('applyBoardLayout 函数存在，且 render() 末尾会调用它', () => {
  const html = tc.readIndexHtml();
  assert.ok(/function applyBoardLayout\(\)/.test(html), '应有 applyBoardLayout 函数');
  const from = html.indexOf('function applyBoardLayout()');
  const to = html.indexOf('function render()', from);
  assert.ok(from > -1 && to > from, '没截到 applyBoardLayout 函数体');
  const fn = html.slice(from, to);
  /* 布局已收敛成单视图：实现固定取 window.BoardLayouts.main，不再按用户选择挑。 */
  assert.ok(/window\.BoardLayouts/.test(fn),
    'applyBoardLayout 应从 window.BoardLayouts 取布局实现');
  assert.ok(/BoardLayouts\.main/.test(fn),
    'applyBoardLayout 应固定走 window.BoardLayouts.main（单视图，不再挑布局）');
  /* ctx 现在由 boardCtx() 造（早先直接写在 applyBoardLayout 里）。
     不管在哪造，交给布局层的那个对象里必须有 api: window.AegisUI。 */
  const ctxFrom = html.indexOf('function boardCtx()');
  const ctxBody = ctxFrom > -1
    ? html.slice(ctxFrom, from)
    : fn;
  assert.ok(/api:\s*window\.AegisUI/.test(ctxBody),
    'ctx 里要把 window.AegisUI 交给布局层');
  const render = html.slice(to, html.indexOf('function renderStats()'));
  assert.ok(/renderBoard\(\);[\s\S]*?applyBoardLayout\(\);/.test(render),
    'render() 画完板要调 applyBoardLayout()，否则板子不重画');
});

test('两个独立视图的变量必须全部能在 theme.css 里找到定义', () => {
  /* credentials-view.css 用 36 个 --cv-*、consumer-view.css 用 30 个 --cvw-*。
     它们的定义原本在这两个 CSS 自己的 :root 里（各自带前缀，所以切皮肤时不会跟着变）；
     现在 theme.css 的 6 组皮肤里各加了一段别名，把它们接到同一套皮肤上，
     这两个视图的 CSS 一个字都没改 —— 所以别名少一条，那个视图就有一处颜色落回浏览器默认值。 */
  const theme = tc.readThemeCss();
  const defined = new Set([...theme.matchAll(/(--[a-z0-9][a-z0-9-]*)\s*:/g)].map(m => m[1]));
  const views = [
    ['credentials-view.css', '--cv-'],
    ['consumer-view.css', '--cvw-']
  ];
  let total = 0;
  for (const [file, prefix] of views) {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    /* var(--x, 兜底) 不算缺：没人定义时浏览器就用兜底值，那是有意写的。 */
    const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9][a-z0-9-]*)\s*[,)]/g)]
      .filter(m => m[0].slice(-1) !== ',')
      .map(m => m[1]));
    const names = [...used].filter(n => n.indexOf(prefix) === 0);
    assert.ok(names.length > 0, file + ' 里没找到 ' + prefix + '* 的变量引用，这条测试在空转');
    total += names.length;
    const missing = names.filter(n => !defined.has(n));
    assert.deepStrictEqual(missing, [],
      file + ' 用到的 ' + prefix + '* 变量在 theme.css 里没有定义，切皮肤时会落回浏览器默认值：' + missing.join(' '));
  }
  assert.ok(total >= 60,
    '两个视图的变量加起来应不少于 60 个（实测 36 + 30 = 66），实得 ' + total + '，多半是上面的收集规则失效了');
});

test('皮肤层与布局层的静态资产：页面要引，服务端白名单也要列（少一条就整块静默消失）', () => {
  const html = tc.readIndexHtml();
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  /* 布局层收敛成一套以后只剩 4 个资产：皮肤变量、布局样式、共享渲染原子、唯一那套布局。 */
  const assets = [
    '/app/theme.css', '/app/layout.css', '/app/layout-shared.js', '/app/layout-main.js'
  ];
  for (const a of assets) {
    assert.ok(html.includes('"' + a + '"'),
      'index.html 没引 ' + a + '：这一块皮肤/布局压根不会加载');
    assert.ok(appJs.includes("'" + a + "':"),
      'APP_ASSETS 白名单里少了 ' + a + '：浏览器请求它会拿到 404，整块静默消失');
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', ...a.slice(1).split('/'))),
      a + ' 在 public 下没有对应文件');
  }
});

test('唯一那套布局：layout-main.js 注册的是 window.BoardLayouts.main，且只注册这一套', () => {
  /* index.html 里的 applyBoardLayout() 是写死取 window.BoardLayouts.main 的。
     所以这个文件要是没把 main 注册出来（或者注册成别的键），板子就是空白，
     而单测看不见——这里把它钉住。 */
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'layout-main.js'), 'utf8');
  assert.ok(/window\.BoardLayouts/.test(src),
    'layout-main.js 应往 window.BoardLayouts 上注册布局');
  assert.ok(/window\.BoardLayouts\s*\.\s*main\s*=/.test(src) ||
    /window\.BoardLayouts\s*\[\s*['"]main['"]\s*\]\s*=/.test(src),
    'layout-main.js 注册的键应是 main（单视图唯一那套）');
  const keys = [...src.matchAll(/window\.BoardLayouts\s*\.\s*([A-Za-z0-9_]+)\s*=/g)].map(m => m[1]);
  const extra = keys.filter(k => k !== 'main');
  assert.deepStrictEqual(extra, [],
    'layout-main.js 不该再注册别的布局键（只剩单视图）：' + extra.join(' '));
});

test('旧的四套布局（layout-a~d.js）已下线：页面不许再引，文件也不许还在', () => {
  const html = tc.readIndexHtml();
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  for (const id of ['a', 'b', 'c', 'd']) {
    const rel = '/app/layout-' + id + '.js';
    assert.ok(!html.includes('"' + rel + '"'),
      'index.html 不该再引 ' + rel + '：布局已收敛成单视图');
    assert.ok(!appJs.includes("'" + rel + "':"),
      'APP_ASSETS 白名单里不该再有 ' + rel + '：旧布局已下线');
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'app', 'layout-' + id + '.js')),
      'public/app 下不该再有 layout-' + id + '.js：旧布局已下线');
  }
});
