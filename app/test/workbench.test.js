const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const batPath = path.join(__dirname, '..', 'workbench.bat');
const jsonPath = path.join(__dirname, '..', 'workbench.json');

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
  assert.ok(fs.existsSync(p.path), `path 应指向真实文件: ${p.path}`);
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
