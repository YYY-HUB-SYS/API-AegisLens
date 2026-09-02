const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const execAsync = promisify(exec);
const batPath = path.join(__dirname, '..', 'start.bat');

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

test('start.bat：服务窗口内再次切换 UTF-8（新控制台不继承代码页）', () => {
  const { text } = readBat();
  assert.ok(
    text.includes('cmd /k "chcp 65001 >nul & node server.js"'),
    'start 命令应在子窗口内先 chcp 65001 再启动 node'
  );
});

test('start.bat：关键结构完整（切目录 / 检测 node / 打开浏览器）', () => {
  const { text } = readBat();
  assert.ok(text.includes('@echo off'));
  assert.ok(text.includes('cd /d "%~dp0"'));
  assert.ok(text.includes('where node'));
  assert.ok(text.includes('http://127.0.0.1:37700'));
});

test('start.bat：子窗口命令链可用（chcp + node 串联执行）', async () => {
  const { stdout } = await execAsync('chcp 65001 >nul & node -e console.log(42)');
  assert.strictEqual(stdout.trim(), '42');
});
