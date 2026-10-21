/* 底栏（#foot-meta）的三态。
   这一行以前是三处各写各的 textContent：解锁后拼版本行、锁上后写「保险库未解锁」、
   连不上时写「服务连接失败」。其中「连不上」和「锁着」会撞：
   服务没起来被说成保险库锁着，人会去输口令而不是查服务。
   这里把三态收进一个出口，顺便钉住一条安全底线：**锁着的时候不许出现数据目录**
   （那是对外的真实路径）。做法照 autorefresh.test.js：按标记切片 + vm 沙箱跑真函数。 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');
const MARK = '/* ================= 底栏：服务元信息 =================';

function section(src, marker) {
  const a = src.indexOf(marker);
  assert.ok(a > -1, 'index.html 里找不到段落标记：' + marker);
  const b = src.indexOf('/* ================= ', a + marker.length);
  assert.ok(b > a, '段落后面没有下一个标记：' + marker);
  return src.slice(a, b);
}

function sandbox() {
  const el = { textContent: '' };
  const sb = {
    console: console,
    document: { getElementById: id => (id === 'foot-meta' ? el : null) }
  };
  vm.createContext(sb);
  vm.runInContext(section(html, MARK), sb, { filename: 'index.html#foot-meta' });
  sb.__el = el;
  return sb;
}

const META = {
  version: '0.1.0',
  metaModels: '2026-10-07',
  storage: 'sqlite',
  dataDir: 'C:\\Users\\someone\\.api-aegislens',
  host: 'DESKTOP-ABC',
  shadowStore: null
};

test('解锁态：版本、存储后端、数据目录、加密说明都在', () => {
  const sb = sandbox();
  const out = sb.footMetaText('unlocked', META);
  assert.ok(out.includes('v0.1.0'), '版本没显示：' + out);
  assert.ok(out.includes('sqlite'), '存储后端没显示：' + out);
  assert.ok(out.includes(META.dataDir), '数据目录没显示：' + out);
  assert.ok(out.includes('AES-256-GCM'), '加密说明没了：' + out);
});

test('锁态：只说保险库未解锁，绝不出现数据目录', () => {
  const sb = sandbox();
  const out = sb.footMetaText('locked', META);
  assert.ok(out.indexOf('保险库未解锁') > -1, '锁态文案不对：' + out);
  assert.strictEqual(out.indexOf(META.dataDir), -1, '锁着的时候数据目录漏出去了：' + out);
  assert.strictEqual(out.indexOf('C:\\Users'), -1, '锁着的时候路径漏出去了：' + out);
});

test('服务连不上：说的是连不上，不是保险库锁着', () => {
  const sb = sandbox();
  const out = sb.footMetaText('offline', null, 'ECONNREFUSED');
  assert.ok(out.indexOf('服务连不上') > -1, '离线文案不对：' + out);
  assert.strictEqual(out.indexOf('保险库未解锁'), -1,
    '服务没起来被说成保险库锁着，人会去输口令而不是查服务：' + out);
  assert.ok(out.indexOf('ECONNREFUSED') > -1, '离线要把原因带上：' + out);
});

test('缺字段不塞 undefined，空着就整段不出现', () => {
  const sb = sandbox();
  const out = sb.footMetaText('unlocked', { version: '0.1.0', storage: null, dataDir: null });
  assert.strictEqual(out.indexOf('undefined'), -1, '底栏出现 undefined：' + out);
  assert.strictEqual(out.indexOf('null'), -1, '底栏出现 null：' + out);
  assert.ok(out.indexOf('本地存储') < 0, '没有存储后端就别留半句「本地存储」：' + out);
});

test('写进 DOM 的也是同一段文本（锁态那条不许带路径）', () => {
  const sb = sandbox();
  sb.footMetaSet('locked', META);
  assert.ok(sb.__el.textContent.indexOf('保险库未解锁') > -1, '没写进 #foot-meta：' + sb.__el.textContent);
  assert.strictEqual(sb.__el.textContent.indexOf(META.dataDir), -1,
    '锁着的时候数据目录被写进了底栏：' + sb.__el.textContent);
  sb.footMetaSet('unlocked', META);
  assert.ok(sb.__el.textContent.indexOf(META.dataDir) > -1, '解锁态该显示数据目录');
});

test('三处写入都走同一个出口，不再有裸的 foot-meta 赋值', () => {
  assert.strictEqual(html.indexOf("getElementById('foot-meta').textContent"), -1,
    '还有地方直接往 #foot-meta 写 textContent，三态会互相覆盖');
  assert.ok(html.includes("footMetaSet('unlocked', m)"), '解锁态没走统一出口');
  assert.ok(html.includes("footMetaSet('error', null, e.message)"), '连接失败没走统一出口');
  assert.ok(html.includes("footMetaSet(mode || 'locked')"), '锁态没走统一出口');
  /* gateScrub 现在认「锁着」和「连不上」两种 */
  assert.ok(html.includes('function gateScrub(mode)'), 'gateScrub 应能区分锁着与连不上');
  assert.ok(html.includes("gateScrub('offline')"), '连不上那条路没标 offline');
});

test('页脚那行在 HTML 里有个固定 id（界面各处都指着它）', () => {
  assert.ok(html.includes('id="foot-meta"'), '底栏少了 id="foot-meta"');
});
