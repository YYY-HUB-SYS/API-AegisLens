/* local-token-usage 的测试。
 *
 * ★ 绝不依赖本机真实数据：所有用例都在临时目录里造假的 sqlite / json，
 *   再用 collectUsage({ root }) 指过去 —— 这也是模块支持"数据根目录可注入"的原因。
 *   （真机上那份 runtime-state.sqlite 有 1GB 且正在被写，测试绝不能去碰它。）
 *
 * 覆盖：按天/按模型/按 agent 的分组求和、时间戳单位自动识别、会话标题绝不外泄、
 *   数据源缺失与格式变化时的优雅降级、sqlite 句柄用完即关（Windows 上句柄不释放就删不掉目录）、
 *   WorkBuddy 上下文占用与消耗口径分开、--days 过滤、cc-switch 接入、CLI 退出码。 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const tmp = require('./tmp.js');
const usage = require('../src/token-usage.js');
/* 先把 node:sqlite 的实验性警告静音，再 require 它，免得测试输出里全是黄字 */
usage.silenceSqliteWarning();
const { DatabaseSync } = require('node:sqlite');
const cli = require('../scripts/local-token-usage.js');

/* 固定"现在"：所有与日期有关的断言都基于它，不受跑测试时的真实时间影响 */
const NOW = new Date(2026, 9, 21, 12, 0, 0, 0).getTime();
/* 故意放进假数据里的敏感串：会话标题。任何输出里都不许出现它 */
const SECRET = '绝密会话标题-DO-NOT-LEAK-42';

function dayMs(y, m, d, h) {
  return new Date(y, m - 1, d, h || 0, 0, 0, 0).getTime();
}

function makeRoot() {
  return tmp.mk('aegis-tok-');
}

/* 造一份同名的 local_runtime_token_usage 表（列名与真机一致），外加一张带 title 的会话表 */
function writeMinimax(root, rows) {
  const dir = path.join(root, '.minimax', 'v2', 'sqlite');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'runtime-state.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE local_runtime_token_usage ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, agent_name TEXT, framework_type TEXT,'
    + ' turn_id TEXT, model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER,'
    + ' reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,'
    + ' cost_usd REAL, raw TEXT)');
  const ins = db.prepare('INSERT INTO local_runtime_token_usage (session_id, agent_name, framework_type,'
    + ' turn_id, model, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,'
    + ' cache_write_tokens, cost_usd, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) {
    ins.run(
      r.sessionId || 'sess-1',
      r.agent === undefined ? 'worker' : r.agent,
      'pi-agent',
      'turn-1',
      r.model === undefined || r.model === null ? null : String(r.model),
      r.ts,
      r.input || 0,
      r.output || 0,
      r.reasoning || 0,
      r.cacheRead || 0,
      r.cacheWrite || 0,
      r.cost || 0,
      r.raw === undefined ? null : r.raw
    );
  }
  /* 真机上就有这张表；造一份带 title 的，用来看住"绝不读会话标题"这条线 */
  db.exec('CREATE TABLE local_runtime_sessions (session_id TEXT, title TEXT, created_at_ms INTEGER)');
  db.prepare('INSERT INTO local_runtime_sessions (session_id, title, created_at_ms) VALUES (?,?,?)')
    .run('sess-1', SECRET, NOW);
  db.close();
  return dbPath;
}

function writeWorkBuddy(root, conversations, rel) {
  const dir = path.join(root, '.workbuddy-ai', 'storage', 'user-x', 'storage-abc', 'scoped', 'hash1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, rel || 'conversationContextUsage.json');
  fs.writeFileSync(file, JSON.stringify(conversations), 'utf8');
  return file;
}

function writeCcSwitch(root, rollups) {
  const dir = path.join(root, '.cc-switch');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'cc-switch.db'));
  db.exec('CREATE TABLE usage_daily_rollups (date TEXT, app_type TEXT, provider_id TEXT, model TEXT,'
    + ' request_count INTEGER, success_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,'
    + ' cache_read_tokens INTEGER, cache_creation_tokens INTEGER, total_cost_usd REAL)');
  const ins = db.prepare('INSERT INTO usage_daily_rollups (date, app_type, provider_id, model,'
    + ' request_count, success_count, input_tokens, output_tokens, cache_read_tokens,'
    + ' cache_creation_tokens, total_cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of rollups) {
    ins.run(r.date, r.appType, 'prov-1', r.model, r.requests, r.requests, r.input, r.output,
      r.cacheRead || 0, r.cacheWrite || 0, r.cost || 0);
  }
  db.close();
}

/* Windows 上文件句柄释放会晚一拍，删文件要带一点退避 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('MiniMax 用量：按天 / 按模型 / 按 agent 三个维度分组求和正确', function () {
  const root = makeRoot();
  const d20 = dayMs(2026, 10, 20);
  const d21 = dayMs(2026, 10, 21);
  writeMinimax(root, [
    { ts: d20 + 3600000, agent: 'worker', model: 'm-1', input: 100, output: 10, reasoning: 1, cacheRead: 5, cacheWrite: 2, cost: 0.001 },
    { ts: d20 + 7200000, agent: 'worker', model: 'm-1', input: 200, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.002 },
    { ts: d21 + 3600000, agent: 'mavis', model: 'm-2', input: 300, output: 30, reasoning: 3, cacheRead: 7, cacheWrite: 0, cost: 0.004 }
  ]);

  const res = usage.collectUsage({ root: root, days: 30, now: NOW });
  const mm = res.consumption.sources.find(function (s) { return s.id === 'minimax-code'; });
  assert.equal(mm.available, true, 'MiniMax 数据源应当可用');
  assert.equal(mm.rows, 3);

  /* 按天 */
  assert.equal(mm.byDay.length, 2);
  const d20b = mm.byDay.find(function (d) { return d.date === '2026-10-20'; });
  assert.ok(d20b, '应有 2026-10-20 这一行');
  assert.equal(d20b.requests, 2);
  assert.equal(d20b.inputTokens, 300);
  assert.equal(d20b.outputTokens, 30);
  assert.equal(d20b.reasoningTokens, 1);
  assert.equal(d20b.cacheReadTokens, 5);
  assert.equal(d20b.cacheWriteTokens, 2);
  assert.equal(d20b.totalTokens, 300 + 30 + 1 + 5 + 2);
  assert.equal(d20b.costUsd, 0.003);
  const d21b = mm.byDay.find(function (d) { return d.date === '2026-10-21'; });
  assert.ok(d21b);
  assert.equal(d21b.requests, 1);
  assert.equal(d21b.inputTokens, 300);
  assert.equal(d21b.costUsd, 0.004);

  /* 按模型 */
  assert.equal(mm.byModel.length, 2);
  const m1 = mm.byModel.find(function (m) { return m.model === 'm-1'; });
  assert.equal(m1.requests, 2);
  assert.equal(m1.inputTokens, 300);
  assert.equal(m1.outputTokens, 30);
  assert.equal(m1.totalTokens, 300 + 30 + 1 + 5 + 2);
  assert.equal(m1.costUsd, 0.003);
  const m2 = mm.byModel.find(function (m) { return m.model === 'm-2'; });
  assert.equal(m2.requests, 1);
  assert.equal(m2.inputTokens, 300);

  /* 按 agent */
  assert.equal(mm.byAgent.length, 2);
  const worker = mm.byAgent.find(function (a) { return a.agent === 'worker'; });
  assert.equal(worker.requests, 2);
  assert.equal(worker.inputTokens, 300);
  assert.equal(worker.totalTokens, 338);
  const mavis = mm.byAgent.find(function (a) { return a.agent === 'mavis'; });
  assert.equal(mavis.requests, 1);
  assert.equal(mavis.totalTokens, 340);

  /* 总量 = 各天之和 */
  assert.equal(mm.total.requests, 3);
  assert.equal(mm.total.totalTokens, 338 + 340);
  assert.equal(mm.total.costUsd, 0.007);
  assert.equal(res.consumption.total.totalTokens, mm.total.totalTokens);
});

test('时间戳单位自动识别：秒与毫秒描述同一时刻时分到同一天', function () {
  assert.equal(usage.detectTsUnit(1792570000633), 'ms');
  assert.equal(usage.detectTsUnit(1792570000), 'sec');
  assert.equal(usage.detectTsUnit(1792570000633000), 'us');

  const when = dayMs(2026, 10, 21) + 3600000;
  const rootMs = makeRoot();
  writeMinimax(rootMs, [{ ts: when, model: 'm-1', input: 10, output: 5 }]);
  const rootSec = makeRoot();
  writeMinimax(rootSec, [{ ts: Math.floor(when / 1000), model: 'm-1', input: 10, output: 5 }]);

  const resMs = usage.collectUsage({ root: rootMs, days: 30, now: NOW });
  const resSec = usage.collectUsage({ root: rootSec, days: 30, now: NOW });
  const mmMs = resMs.consumption.sources.find(function (s) { return s.id === 'minimax-code'; });
  const mmSec = resSec.consumption.sources.find(function (s) { return s.id === 'minimax-code'; });

  assert.equal(mmMs.tsUnit, 'ms');
  assert.equal(mmSec.tsUnit, 'sec');
  assert.equal(mmSec.byDay.length, 1);
  assert.equal(mmSec.byDay[0].date, '2026-10-21');
  assert.deepEqual(
    mmSec.byDay.map(function (d) { return [d.date, d.inputTokens, d.outputTokens]; }),
    mmMs.byDay.map(function (d) { return [d.date, d.inputTokens, d.outputTokens]; })
  );
});

test('会话标题与 raw 内容不出现在任何输出里', function () {
  const root = makeRoot();
  writeMinimax(root, [
    { ts: dayMs(2026, 10, 21) + 3600000, model: 'm-1', input: 10, output: 5, raw: JSON.stringify({ note: SECRET }) }
  ]);

  const res = usage.collectUsage({ root: root, days: 30, now: NOW });
  const json = usage.renderJson(res);
  const text = usage.renderText(res);

  assert.ok(!json.includes(SECRET), 'JSON 结果里出现了会话标题');
  assert.ok(!text.includes(SECRET), '文本输出里出现了会话标题');
  /* 会话 id 也不该外泄 */
  assert.ok(!json.includes('sess-1'), 'JSON 结果里出现了会话 id');
  assert.ok(!text.includes('sess-1'), '文本输出里出现了会话 id');
});

test('数据源不存在 / 格式变了：返回空结果而不是抛异常', function () {
  const root = makeRoot();
  const res = usage.collectUsage({ root: root, days: 30, now: NOW });

  assert.equal(res.availableSources, 0);
  assert.equal(res.consumption.total.requests, 0);
  assert.equal(res.consumption.total.totalTokens, 0);
  assert.ok(res.unavailable.some(function (u) { return u.id === 'minimax-code'; }));
  assert.ok(res.unavailable.some(function (u) { return u.id === 'workbuddy-ai'; }));
  assert.ok(res.unavailable.some(function (u) { return u.id === 'codebuddy'; }), '探查过但没数据的 agent 要如实列出');

  /* 渲染也不能炸 */
  const text = usage.renderText(res);
  assert.ok(text.indexOf('没有任何可用的数据源') >= 0);
  assert.ok(usage.renderSources(res).indexOf('MiniMax Code') >= 0);
  assert.ok(usage.renderJson(res).indexOf('minimax-code') >= 0);
});

test('sqlite 文件不是库 / 缺表：优雅降级并写明原因', function () {
  const root = makeRoot();
  const dir = path.join(root, '.minimax', 'v2', 'sqlite');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime-state.sqlite'), 'this is not a sqlite database', 'utf8');

  const res = usage.collectUsage({ root: root, days: 30, now: NOW });
  const mm = res.consumption.sources.find(function (s) { return s.id === 'minimax-code'; });
  assert.equal(mm.available, false);
  assert.ok(mm.reason && mm.reason.length > 0, '不可用时要写清原因');
  assert.equal(res.availableSources, 0);
});

test('sqlite 句柄用完即关：读完就能把文件删掉（Windows 上不关就删不掉）', function () {
  const root = makeRoot();
  const dbPath = writeMinimax(root, [{ ts: dayMs(2026, 10, 21) + 3600000, model: 'm-1', input: 10, output: 5 }]);

  const res = usage.collectUsage({ root: root, days: 30, now: NOW });
  assert.equal(res.consumption.sources.find(function (s) { return s.id === 'minimax-code'; }).available, true);

  let deleted = false;
  let lastError = null;
  for (let i = 0; i < 20 && !deleted; i++) {
    try {
      fs.rmSync(dbPath, { force: true });
      deleted = true;
    } catch (e) {
      lastError = e;
      sleepMs(50);
    }
  }
  assert.ok(deleted, 'sqlite 句柄没释放，文件删不掉：' + (lastError ? lastError.message : ''));
});

test('WorkBuddy 上下文占用：按模型/按类别/按更新日聚合，且不混进消耗口径', function () {
  const root = makeRoot();
  writeWorkBuddy(root, {
    'conv-a': {
      version: 1, used: 1000, size: 2000,
      usageByCategory: { systemPrompt: 100, conversation: 800, tools: 50, mcp: 10, skills: 40, version: 1 },
      hasCompletedLlmCall: true, modelId: 'hy3', updatedAt: dayMs(2026, 10, 21)
    },
    'conv-b': {
      version: 1, used: 3000, size: 4000,
      usageByCategory: { systemPrompt: 200, conversation: 2600, tools: 100, mcp: 20, skills: 80, version: 1 },
      hasCompletedLlmCall: true, modelId: 'hy3', updatedAt: dayMs(2026, 10, 20)
    },
    'conv-c': {
      version: 1, used: 500, size: 1000,
      usageByCategory: { systemPrompt: 50, conversation: 400, tools: 30, mcp: 10, skills: 10, version: 1 },
      hasCompletedLlmCall: true, modelId: 'other', updatedAt: dayMs(2026, 8, 1)
    }
  });

  const res = usage.collectUsage({ root: root, days: 30, now: NOW });
  const wb = res.context.sources.find(function (s) { return s.id === 'workbuddy-ai'; });
  assert.equal(wb.available, true);
  assert.equal(wb.conversations, 3);
  assert.equal(wb.total.used, 4500);
  assert.equal(wb.total.size, 7000);
  assert.equal(wb.total.remaining, 2500);

  const hy3 = wb.byModel.find(function (m) { return m.model === 'hy3'; });
  assert.equal(hy3.conversations, 2);
  assert.equal(hy3.used, 4000);
  assert.equal(hy3.size, 6000);
  assert.equal(hy3.remaining, 2000);

  const cats = {};
  for (const c of wb.byCategory) cats[c.category] = c.tokens;
  assert.equal(cats.systemPrompt, 350);
  assert.equal(cats.conversation, 3800);
  assert.equal(cats.tools, 180);

  /* 窗口外的会话不进"按最近更新日"，但仍算在当前占用里 */
  assert.equal(wb.byDay.length, 2);
  assert.equal(wb.updatedInWindow, 2);

  /* ★ 上下文占用不是消耗：消耗类那边必须是 0 */
  assert.equal(res.consumption.total.requests, 0);
  assert.equal(res.consumption.total.totalTokens, 0);

  /* 会话 id 不许出现在结果里 */
  const json = usage.renderJson(res);
  assert.ok(!json.includes('conv-a'));
  assert.ok(!json.includes('conv-b'));
  assert.ok(!json.includes('conv-c'));
});

test('--days N 只保留窗口内的记录', function () {
  const root = makeRoot();
  writeMinimax(root, [
    { ts: dayMs(2026, 10, 21) + 3600000, model: 'm-1', input: 10, output: 5 },
    { ts: dayMs(2026, 9, 1) + 3600000, model: 'm-1', input: 99, output: 99 }
  ]);

  const res7 = usage.collectUsage({ root: root, days: 7, now: NOW });
  const mm7 = res7.consumption.sources.find(function (s) { return s.id === 'minimax-code'; });
  assert.equal(mm7.rows, 1);
  assert.equal(mm7.total.inputTokens, 10);

  const res60 = usage.collectUsage({ root: root, days: 60, now: NOW });
  const mm60 = res60.consumption.sources.find(function (s) { return s.id === 'minimax-code'; });
  assert.equal(mm60.rows, 2);
  assert.equal(mm60.total.inputTokens, 109);
});

test('cc-switch 日聚合接入：按天/按模型/按 agent 聚合', function () {
  const root = makeRoot();
  writeCcSwitch(root, [
    { date: '2026-10-20', appType: 'claude', model: 'claude-x', requests: 10, input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, cost: 0.5 },
    { date: '2026-10-21', appType: 'codex', model: 'gpt-y', requests: 4, input: 400, output: 80, cost: 0.25 }
  ]);

  const res = usage.collectUsage({ root: root, days: 30, now: NOW });
  const cs = res.consumption.sources.find(function (s) { return s.id === 'cc-switch'; });
  assert.equal(cs.available, true);
  assert.equal(cs.rows, 2);
  assert.ok(cs.detail.indexOf('usage_daily_rollups') >= 0);
  assert.equal(cs.total.inputTokens, 1400);
  assert.equal(cs.total.outputTokens, 280);
  assert.equal(cs.total.cacheReadTokens, 50);
  assert.equal(cs.total.costUsd, 0.75);

  const claude = cs.byAgent.find(function (a) { return a.agent === 'claude'; });
  assert.equal(claude.requests, 10);
  assert.equal(claude.inputTokens, 1000);
  const gpt = cs.byModel.find(function (m) { return m.model === 'gpt-y'; });
  assert.equal(gpt.requests, 4);
  assert.equal(gpt.inputTokens, 400);
});

test('CLI：参数解析、输出与退出码', function () {
  assert.equal(cli.parseArgs(['--days', '7']).days, 7);
  assert.equal(cli.parseArgs(['--days=9']).days, 9);
  assert.equal(cli.parseArgs([]).days, usage.DEFAULT_DAYS);
  assert.equal(cli.parseArgs(['--json']).json, true);
  assert.equal(cli.parseArgs(['--sources']).sources, true);
  assert.throws(function () { cli.parseArgs(['--days', '0']); });
  assert.throws(function () { cli.parseArgs(['--nope']); });

  const root = makeRoot();
  /* 用真实时间戳造数据，CLI 用的是真时钟 */
  writeMinimax(root, [{ ts: Date.now(), model: 'm-1', input: 10, output: 5, raw: SECRET }]);

  const out = [];
  const errs = [];
  const code = cli.runCli(['--root', root], { out: function (l) { out.push(l); }, err: function (l) { errs.push(l); } });
  assert.equal(code, 0, '有可用数据源时退出码应为 0');
  const text = out.join('\n');
  assert.ok(text.indexOf('消耗类') >= 0);
  assert.ok(text.indexOf('上下文占用类') >= 0);
  assert.ok(!text.includes(SECRET), 'CLI 输出里出现了敏感内容');

  const jsonOut = [];
  const code2 = cli.runCli(['--json', '--root', root], { out: function (l) { jsonOut.push(l); }, err: function () { } });
  assert.equal(code2, 0);
  const parsed = JSON.parse(jsonOut.join('\n'));
  assert.ok(parsed.consumption.sources.some(function (s) { return s.id === 'minimax-code' && s.available; }));

  const srcOut = [];
  cli.runCli(['--sources', '--root', root], { out: function (l) { srcOut.push(l); }, err: function () { } });
  const srcText = srcOut.join('\n');
  assert.ok(srcText.indexOf('MiniMax Code') >= 0);
  assert.ok(srcText.indexOf('CodeBuddy') >= 0, '探查过但没数据的 agent 也要列出来');

  /* 一个数据源都没有：退出码 1，并把原因写到 stderr */
  const empty = makeRoot();
  const emptyOut = [];
  const emptyErr = [];
  const code3 = cli.runCli(['--root', empty], { out: function (l) { emptyOut.push(l); }, err: function (l) { emptyErr.push(l); } });
  assert.equal(code3, 1);
  assert.ok(emptyErr.join('\n').indexOf('没有任何可用的数据源') >= 0);
});
