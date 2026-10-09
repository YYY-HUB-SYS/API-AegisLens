const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const batPath = path.join(__dirname, '..', 'start.bat');
const stopBatPath = path.join(__dirname, '..', 'stop.bat');

function readBat() {
  const buf = fs.readFileSync(batPath);
  return { buf: buf, text: buf.toString('utf8') };
}

test('start.bat：UTF-8 无 BOM（BOM 会导致首行 @echo off 解析失败）', () => {
  const { buf } = readBat();
  assert.ok(
    !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf),
    '文件不应以 UTF-8 BOM 开头'
  );
});

test('start.bat：全部使用 CRLF 行尾（批处理标准，避免块解析异常）', () => {
  const { text } = readBat();
  assert.ok(text.includes('\r\n'), '应包含 CRLF 行尾');
  const loneLf = text.replace(/\r\n/g, '');
  assert.ok(!loneLf.includes('\n'), '不应存在孤立的 LF');
});

test('start.bat：chcp 65001 必须先于任何中文执行', () => {
  const { text } = readBat();
  const chcpIdx = text.indexOf('chcp 65001');
  assert.ok(chcpIdx > 0, '应包含 chcp 65001');
  const firstChinese = text.search(/[\u4e00-\u9fff]/);
  assert.ok(
    firstChinese === -1 || firstChinese > chcpIdx,
    '中文字符只能出现在 chcp 65001 之后'
  );
});

test('start.bat：用 --daemon 起后台实例，不再开子控制台窗口', () => {
  const { text } = readBat();
  assert.ok(
    text.includes('node server.js --daemon'),
    '应交给 --daemon 后台化，关掉这个窗口服务照常在跑'
  );
  assert.ok(
    !/cmd\s+\/k/i.test(text),
    '不应再出现 cmd /k 子窗口——那正是「窗口一关服务就停」的形态，已由 --daemon 取代'
  );
});

test('start.bat：关键结构完整（切目录 / 检测 node / 打开浏览器）', () => {
  const { text } = readBat();
  assert.ok(text.includes('@echo off'));
  assert.ok(text.includes('cd /d "%~dp0"'));
  assert.ok(text.includes('where node'));
  assert.ok(text.includes('http://127.0.0.1:37700'));
});

test('两个 bat 依赖的开关在 server.js 里真的存在（bat 与 CLI 不能各说各话）', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/--daemon/.test(server), 'server.js 必须处理 --daemon');
  assert.ok(/--stop/.test(server), 'server.js 必须处理 --stop');
});

test('stop.bat：与 start.bat 同一套编码约束，停止动作交给 server.js --stop', () => {
  const buf = fs.readFileSync(stopBatPath);
  assert.ok(
    !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf),
    'stop.bat 不应以 UTF-8 BOM 开头'
  );
  const text = buf.toString('utf8');
  assert.ok(
    text.indexOf('chcp 65001') > 0 &&
      (text.search(/[一-鿿]/) === -1 || text.search(/[一-鿿]/) > text.indexOf('chcp 65001')),
    'stop.bat 的中文字符只能出现在 chcp 65001 之后'
  );
  assert.ok(
    text.includes('@echo off') && text.includes('cd /d "%~dp0"') && text.includes('node server.js --stop'),
    'stop.bat 应切到脚本目录后执行 server.js --stop'
  );
  assert.strictEqual(
    (text.match(/(^|[^\r])\n/g) || []).length,
    0,
    'stop.bat 不应存在孤立的 LF'
  );
});
