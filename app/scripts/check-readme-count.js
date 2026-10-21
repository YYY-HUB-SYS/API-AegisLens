/* 核对 README（中英）写的测试数与实跑一致。
 *
 * 为什么要有：README 顶部有个徽章、正文有一句「tests N / pass N」，
 * 那是给人看的**对外口径**。早先它写 599、实跑已经 688 —— 漂了一个多月没人发现，
 * 因为 `docs.test.js` 盯的是**路由数**与 **data-act 数**，不盯测试数。
 *
 * 为什么是**独立脚本**而不是一条测试：
 * 在 `node --test` 内部再 spawn 一个 `node --test`，内层在 Windows 上根本跑不起来
 * （实测：外层 115ms 就返回 status=null，内层一条也没跑）。所以这条核对必须跑在
 * 测试进程**外面**：CI 的一个独立 step，或本地 `npm run check:readme`。
 *
 * 退出码 0 = 对上了；1 = 没对上（并说清差多少）。 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const APP = path.join(__dirname, '..');
const ROOT = path.join(APP, '..');

function runFullSuite() {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/*.test.js'], {
    cwd: APP,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const out = (r.stdout || '') + (r.stderr || '');
  /* 行尾是 CRLF：`$` 只匹配到 \n 之前，\r 会卡住锚点 ⇒ 收尾用 `[ \t]*\r?$` */
  const t = out.match(/^# tests (\d+)[ \t]*\r?$/m);
  const p = out.match(/^# pass (\d+)[ \t]*\r?$/m);
  const f = out.match(/^# fail (\d+)[ \t]*\r?$/m);
  if (!t || !p) {
    console.error('跑不出测试数摘要（node --test 退出码 ' + r.status + '）。输出尾部：');
    console.error(out.split(/\r?\n/).slice(-20).join('\n'));
    process.exit(2);
  }
  return { tests: Number(t[1]), pass: Number(p[1]), fail: f ? Number(f[1]) : 0 };
}

function main() {
  const counts = runFullSuite();
  if (counts.fail > 0) {
    console.error('全量测试本身有 ' + counts.fail + ' 条红的，先修那些 —— 测试数对不对是次要的。');
    process.exit(1);
  }
  const problems = [];
  for (const doc of ['README.md', 'README_EN.md']) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    /* 正文的「tests N / pass N / fail 0」 */
    const inline = text.match(/`tests (\d+) \/ pass (\d+) \/ fail (\d+)`/);
    if (!inline) {
      problems.push(doc + ' 里找不到「tests N / pass N / fail N」那句');
    } else {
      if (Number(inline[1]) !== counts.tests) {
        problems.push(doc + ' 写的测试数 ' + inline[1] + ' ≠ 实跑 ' + counts.tests);
      }
      if (Number(inline[2]) !== counts.pass) {
        problems.push(doc + ' 写的通过数 ' + inline[2] + ' ≠ 实跑 ' + counts.pass);
      }
      if (Number(inline[3]) !== 0) {
        problems.push(doc + ' 写的失败数不是 0');
      }
    }
    /* 顶部徽章里的那个数（徽章是给人第一眼看的，更容易漂） */
    const badge = text.match(/badge\/(?:测试|tests)-(\d+)%/);
    if (!badge) {
      problems.push(doc + ' 的测试徽章里没有数字');
    } else if (Number(badge[1]) !== counts.tests) {
      problems.push(doc + ' 徽章写的 ' + badge[1] + ' ≠ 实跑 ' + counts.tests);
    }
  }
  if (problems.length) {
    console.error('README 的测试数与实跑对不上：');
    for (const p of problems) console.error('  - ' + p);
    console.error('（实跑：tests ' + counts.tests + ' / pass ' + counts.pass + ' / fail ' + counts.fail + '）');
    process.exit(1);
  }
  console.log('README（中英）的测试数与实跑一致：tests ' + counts.tests + ' / pass ' + counts.pass + ' / fail 0');
}

main();
