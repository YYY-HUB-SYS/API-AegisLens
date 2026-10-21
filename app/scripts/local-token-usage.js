#!/usr/bin/env node
/* 本机 AI agent 的 token 计量 CLI。
 *
 *   node app/scripts/local-token-usage.js            人话表格（按天/按模型/按 agent）
 *   node app/scripts/local-token-usage.js --days 7   只看最近 7 天
 *   node app/scripts/local-token-usage.js --json     输出 JSON，给别的脚本消费
 *   node app/scripts/local-token-usage.js --sources  只列探测到哪些数据源、哪些不可用
 *
 * 退出码：0 = 至少有一个数据源可用；1 = 一个都没有（stderr 会写清每条原因）。
 *
 * ★ 只读、只出数字：数据采集与聚合全在 ../src/token-usage.js 里，
 *   sqlite 一律只读打开、用完 close()，输出里没有会话标题/消息正文/带用户名的绝对路径。
 *
 * ★ --root 是给自测和"想指向别处"用的：它顶替 %USERPROFILE%（数据根目录可注入）。 */

'use strict';

const {
  DEFAULT_DAYS,
  collectUsage,
  renderText,
  renderJson,
  renderSources
} = require('../src/token-usage.js');

const USAGE = [
  '用法：node app/scripts/local-token-usage.js [选项]',
  '',
  '  --days N     只看最近 N 天（默认 ' + DEFAULT_DAYS + '）',
  '  --json       输出 JSON（便于脚本消费）',
  '  --sources    只列探测到的数据源与不可用原因',
  '  --root DIR   指定数据根目录（顶替 %USERPROFILE%，默认取用户目录）',
  '  --help       显示这段说明',
  '',
  '退出码：0 = 有可用数据源；1 = 没有任何可用数据源。'
].join('\n');

/* 参数解析：容忍 --days 7 / --days=7 两种写法 */
function parseArgs(argv) {
  const args = { days: DEFAULT_DAYS, json: false, sources: false, root: null, help: false };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const raw = String(list[i]);
    if (raw === '--help' || raw === '-h') { args.help = true; continue; }
    if (raw === '--json') { args.json = true; continue; }
    if (raw === '--sources') { args.sources = true; continue; }
    if (raw === '--days' || raw.startsWith('--days=')) {
      const inline = raw.startsWith('--days=') ? raw.slice('--days='.length) : null;
      let value = inline;
      if (value === null) {
        value = list[i + 1];
        i += 1;
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error('--days 需要一个正整数，收到：' + JSON.stringify(value));
      }
      args.days = Math.floor(n);
      continue;
    }
    if (raw === '--root' || raw.startsWith('--root=')) {
      const inline = raw.startsWith('--root=') ? raw.slice('--root='.length) : null;
      let value = inline;
      if (value === null) {
        value = list[i + 1];
        i += 1;
      }
      if (!value) throw new Error('--root 需要一个目录路径');
      args.root = String(value);
      continue;
    }
    throw new Error('不认识的参数：' + raw);
  }
  return args;
}

/* io 可注入（测试里换成假的 stdout/stderr，不必 spawn 子进程） */
function runCli(argv, io) {
  const out = (io && io.out) || function (line) { console.log(line); };
  const err = (io && io.err) || function (line) { console.error(line); };

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err('参数错误：' + e.message);
    err(USAGE);
    return 2;
  }

  if (args.help) {
    out(USAGE);
    return 0;
  }

  let result;
  try {
    result = collectUsage({ root: args.root || undefined, days: args.days });
  } catch (e) {
    /* 采集本身不该抛（内部都降级了），真抛了也不许把栈糊在用户脸上 */
    err('统计失败：' + e.message);
    return 1;
  }

  if (args.sources) {
    out(renderSources(result));
  } else if (args.json) {
    out(renderJson(result));
  } else {
    out(renderText(result));
  }

  if (!result.availableSources) {
    err('没有任何可用的数据源 —— 每个源为什么不可用已列在上面。');
    return 1;
  }
  return 0;
}

module.exports = { parseArgs: parseArgs, runCli: runCli, USAGE: USAGE };

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2), null));
}
