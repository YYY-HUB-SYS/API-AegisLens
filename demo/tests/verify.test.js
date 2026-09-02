const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log('PASS  ' + name);
  } else {
    console.error('FAIL  ' + name);
    failed++;
  }
}

// 1. 基本结构
check('HTML 含 doctype', /^<!DOCTYPE html>/i.test(html));
check('HTML 含 <html>/<head>/<body>', /<html[\s>]/.test(html) && /<head[\s>]/.test(html) && /<body[\s>]/.test(html));
check('script/style 标签配对', (html.match(/<script[\s>]/g) || []).length === (html.match(/<\/script>/g) || []).length
  && (html.match(/<style[\s>]/g) || []).length === (html.match(/<\/style>/g) || []).length);

// 2. JS 引用的元素 ID 均存在于 HTML 中
const idRefs = new Set();
let m;
const reGet = /getElementById\(\s*'([^']+)'\s*\)/g;
while ((m = reGet.exec(html))) idRefs.add(m[1]);
const htmlIds = new Set();
const reId = /\sid="([^"]+)"/g;
while ((m = reId.exec(html))) htmlIds.add(m[1]);

let missing = [];
for (const id of idRefs) {
  if (!htmlIds.has(id)) missing.push(id);
}
check('JS getElementById 引用的 ' + idRefs.size + ' 个 ID 全部存在' + (missing.length ? '，缺失: ' + missing.join(', ') : ''), missing.length === 0);

// 3. 关键界面元素
const mustHave = [
  'id="board"', 'id="stats"', 'id="btn-add"', 'id="btn-refresh-all"', 'id="btn-reset"',
  'id="overlay-form"', 'id="overlay-config"', 'id="toasts"',
  'id="f-platform"', 'id="f-name"', 'id="f-key"', 'id="f-base"', 'id="f-model"', 'id="f-reg"', 'id="f-exp"',
  'id="btn-reg-now"',
  'id="config-pre"', 'id="seg-tool"', 'id="btn-copy-config"'
];
mustHave.forEach(sel => check('存在元素 ' + sel, html.includes(sel)));

// 4. 关键功能实现标记
const feat = {
  'localStorage 持久化': /localStorage\.setItem/.test(html) && /localStorage\.getItem/.test(html),
  '剪贴板复制（含降级）': /navigator\.clipboard/.test(html) && /execCommand\('copy'\)/.test(html),
  '平台注册表': /PLATFORMS\s*=/.test(html),
  '预置数据': /seedData/.test(html),
  '密钥掩码（末4位）': /maskKey/.test(html),
  '明文/掩码切换': /data-act="reveal"/.test(html),
  '状态计算（有效/临期/过期）': /keyStatus/.test(html) && ST(),
  '模型拉取模拟': /fetchModels/.test(html) && /modelsLoading/.test(html),
  '注册时间「现在」按钮': /btn-reg-now/.test(html) && /fmtDate\(new Date\(\)\)/.test(html),
  '模型参数复制具体数值': /data-copy="' \+ m\.ctx \+ '"/.test(html) && /data-copy="' \+ m\.out \+ '"/.test(html),
  '手动添加模型': /data-act="toggle-manual"/.test(html) && /data-act="add-model"/.test(html) && /data-mf="id"/.test(html),
  '设为默认模型': /data-act="set-model"/.test(html),
  '配置生成三模板': /buildConfig/.test(html) && /dify/.test(html) && /n8n/.test(html) && /env/.test(html),
  '配置带入上下文/最大输出': /CONTEXT_WINDOW/.test(html) && /MAX_OUTPUT/.test(html) && /maxOutputTokens/.test(html),
  '删除二次确认': /armed/.test(html) && /确认删除/.test(html),
  '同名密钥校验': /已存在同名密钥/.test(html),
  'Key 名称自动生成': /autoName/.test(html),
  '平台联动填充': /fPlatform\.addEventListener\('change'/.test(html),
  'Toast 提示': /function toast/.test(html),
  '空状态引导': /还没有任何密钥/.test(html),
  '重置演示数据': /btn-reset/.test(html) && /seedData\(\)/.test(html)
};
function ST() { return /'有效'/.test(html) && /'临期'/.test(html) && /'已过期'/.test(html); }
Object.keys(feat).forEach(k => check('功能: ' + k, feat[k]));

// 5. 表单字段与 PRD 一致性（七个字段）
['平台', 'Key 名称', 'API Key', 'Base URL', '默认模型', '注册时间', '有效期至'].forEach(f =>
  check('表单字段: ' + f, html.includes(f)));

// 6. data-act 事件都有处理分支
const acts = new Set();
const reAct = /data-act="([^"]+)"/g;
while ((m = reAct.exec(html))) acts.add(m[1]);
['copy', 'reveal', 'edit', 'del', 'toggle-models', 'fetch-models', 'set-model', 'toggle-manual', 'add-model', 'config'].forEach(a =>
  check('事件分支处理 ' + a, acts.has(a) && new RegExp("act === '" + a + "'").test(html)));

console.log('');
if (failed === 0) {
  console.log('全部测试通过');
  process.exit(0);
} else {
  console.error(failed + ' 项测试失败');
  process.exit(1);
}
