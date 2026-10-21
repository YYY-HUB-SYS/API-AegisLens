/* 主密钥放哪儿：盘上明文文件 vs 系统凭据管理器。
 *
 * 这层的安全语义比功能更要紧，三条线必须钉住：
 * ① **老库零改动**：已有的明文 master.key 不会被代码自动搬走。
 *    改用户的信任根不能由代码替他决定——凭据管理器写失败或换机器读不到，整库就永久解不开。
 * ② **新库默认进凭据管理器**，但用不了就静默退回文件模式：
 *    「搬不进去」绝不能变成「服务起不来」。
 * ③ **搬动的顺序**：先写凭据，再动盘上文件。反过来做，中间崩了就两头都没有。
 *
 * 测法：把 keystore 的凭据存取换成一个内存假实现（真凭据管理器会污染用户机器，
 * 而且 CI 上根本没有），验证的是本项目的决策逻辑，不是操作系统行为。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const tmp = require('./tmp.js');

/* 替掉整个 keystore 模块：用一个内存 Map 当凭据管理器。
   require 缓存里换掉 crypto.js 依赖的那一份。 */
function withFakeKeyring(opts, fn) {
  const o = opts || {};
  const store = new Map();
  /* 键要跟真实现一致：真 keystore 用 path.resolve(dataDir) 做条目名。
     这里也用 resolve，否则同一份数据目录写成 'x/' 和 'x' 会落到两个条目上。 */
  const keyOf = function (dir) { return path.resolve(dir); };
  const fake = {
    SERVICE: 'API-AegisLens',
    isAvailable: function () { return o.available !== false; },
    getSecret: function (dataDir) {
      if (!store.has(keyOf(dataDir))) return null;
      return Buffer.from(store.get(keyOf(dataDir)), 'hex');
    },
    setSecret: function (dataDir, secret) {
      if (o.writeFails) return false;
      store.set(keyOf(dataDir), Buffer.from(secret).toString('hex'));
      return true;
    },
    deleteSecret: function (dataDir) { return store.delete(keyOf(dataDir)); },
    hasSecret: function (dataDir) { return store.has(keyOf(dataDir)); },
    describe: function () { return { available: o.available !== false, inUse: store.size > 0, service: 'API-AegisLens' }; },
    cleanupProbe: function () { }
  };
  const ksPath = require.resolve('../src/keystore');
  const orig = require.cache[ksPath];
  require.cache[ksPath] = { id: ksPath, filename: ksPath, loaded: true, exports: fake };
  /* crypto.js 是 require 缓存的，得重新加载才能拿到假的 keystore */
  const cryptoPath = require.resolve('../src/crypto');
  delete require.cache[cryptoPath];
  const crypto = require('../src/crypto');
  try {
    return fn(crypto, fake);
  } finally {
    if (orig) require.cache[ksPath] = orig; else delete require.cache[ksPath];
    delete require.cache[cryptoPath];
  }
}

function newDir() { return tmp.mk('akm-mk'); }

function readKeyFile(dir) {
  return fs.readFileSync(path.join(dir, 'master.key'), 'utf8').trim();
}

test('新库：凭据管理器可用时主密钥进凭据管理器，盘上只留占位标记（不含密钥）', () => {
  withFakeKeyring({}, function (crypto) {
    const dir = newDir();
    const key = crypto.loadOrCreateMasterKey(dir);
    assert.strictEqual(key.length, 32, '拿到的必须是 32 字节主密钥');
    const onDisk = readKeyFile(dir);
    assert.ok(onDisk.startsWith('os:v1:'), '盘上应是占位标记，实得：' + onDisk.slice(0, 20));
    assert.strictEqual(onDisk.includes(key.toString('hex')), false, '★ 盘上绝不能出现主密钥本身');
    assert.strictEqual(crypto.masterKeySource(dir), 'os');
  });
});

test('新库：凭据管理器不可用时静默退回盘上明文文件（服务必须能起来）', () => {
  withFakeKeyring({ available: false }, function (crypto) {
    const dir = newDir();
    const key = crypto.loadOrCreateMasterKey(dir);
    assert.strictEqual(key.length, 32);
    const onDisk = readKeyFile(dir);
    assert.ok(!onDisk.startsWith('os:v1:'), '退回时不该写占位标记');
    assert.strictEqual(onDisk, key.toString('hex'), '退回时主密钥照旧写盘上（老行为）');
    assert.strictEqual(crypto.masterKeySource(dir), 'file');
  });
});

test('新库：凭据管理器可用但写不进去（权限/daemon 异常）也必须退回，不能起不来', () => {
  withFakeKeyring({ available: true, writeFails: true }, function (crypto) {
    const dir = newDir();
    const key = crypto.loadOrCreateMasterKey(dir);
    assert.strictEqual(key.length, 32, '写不进凭据管理器也要把主密钥拿到');
    assert.strictEqual(readKeyFile(dir), key.toString('hex'), '退回写盘上明文');
    assert.strictEqual(crypto.masterKeySource(dir), 'file');
  });
});

test('老库：盘上已有的明文 master.key 一个字节都不改（不自动搬走）', () => {
  withFakeKeyring({}, function (crypto) {
    const dir = newDir();
    const orig = 'a'.repeat(64);
    fs.writeFileSync(path.join(dir, 'master.key'), orig, { mode: 0o600 });
    const key = crypto.loadOrCreateMasterKey(dir);
    assert.strictEqual(key.toString('hex'), orig, '读出来的主密钥必须还是原来那个');
    assert.strictEqual(readKeyFile(dir), orig, '★ 老库的盘上文件不许被自动改写');
    assert.strictEqual(crypto.masterKeySource(dir), 'file');
  });
});

test('老库搬家：先写凭据再改盘上文件，顺序反了会两头都没有', () => {
  withFakeKeyring({}, function (crypto) {
    const dir = newDir();
    const orig = 'b'.repeat(64);
    fs.writeFileSync(path.join(dir, 'master.key'), orig, { mode: 0o600 });
    const r = crypto.migrateMasterKeyToKeyring(dir);
    assert.strictEqual(r.migrated, true, r.reason);
    const onDisk = readKeyFile(dir);
    assert.ok(onDisk.startsWith('os:v1:'), '盘上应换成占位标记');
    assert.strictEqual(onDisk.includes(orig), false, '★ 盘上不能还留着明文主密钥');
    /* 搬完之后必须还读得出来同一个主密钥 —— 否则整库就废了 */
    const back = crypto.loadOrCreateMasterKey(dir);
    assert.strictEqual(back.toString('hex'), orig, '搬完必须还读得到同一个主密钥');
    assert.strictEqual(crypto.masterKeySource(dir), 'os');
  });
});

test('老库搬家：写不进凭据管理器就不搬（盘上文件保持原样）', () => {
  withFakeKeyring({ writeFails: true }, function (crypto) {
    const dir = newDir();
    const orig = 'c'.repeat(64);
    fs.writeFileSync(path.join(dir, 'master.key'), orig, { mode: 0o600 });
    const r = crypto.migrateMasterKeyToKeyring(dir);
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(readKeyFile(dir), orig, '搬不动就别动盘上文件');
    assert.strictEqual(crypto.masterKeySource(dir), 'file');
  });
});

test('搬回文件：凭据管理器里的那份被删掉，主密钥回到盘上', () => {
  withFakeKeyring({}, function (crypto) {
    const dir = newDir();
    const orig = 'd'.repeat(64);
    fs.writeFileSync(path.join(dir, 'master.key'), orig, { mode: 0o600 });
    crypto.migrateMasterKeyToKeyring(dir);
    const back = crypto.migrateMasterKeyToFile(dir);
    assert.strictEqual(back.migrated, true, back.reason);
    assert.strictEqual(readKeyFile(dir), orig, '主密钥要回到盘上');
    assert.strictEqual(crypto.masterKeySource(dir), 'file');
  });
});

test('换机器：凭据管理器里读不到主密钥时，错误要说清怎么办（不是笼统说「已损坏」）', () => {
  withFakeKeyring({}, function (crypto) {
    const dir = newDir();
    crypto.loadOrCreateMasterKey(dir);
    /* 模拟「换了台机器」：凭据管理器里没有这条 */
    const other = newDir();
    fs.writeFileSync(path.join(other, 'master.key'), 'os:v1:主密钥在系统凭据管理器里，本文件不含密钥\n', { mode: 0o600 });
    assert.throws(function () { crypto.loadOrCreateMasterKey(other); }, function (e) {
      assert.match(e.message, /凭据管理器/, '要说清是凭据管理器的问题');
      assert.match(e.message, /这台机器上读不到/, '要说清是「这台机器上」读不到');
      assert.strictEqual(e.message.includes('已损坏'), false, '不能笼统说「已损坏」');
      return true;
    });
  });
});

test('「拆除明文副本」：主密钥在凭据管理器里时，删盘上占位文件等于什么都没做', () => {
  withFakeKeyring({}, function (crypto) {
    const dir = newDir();
    crypto.loadOrCreateMasterKey(dir);
    /* 先设口令，discardRawDek 要求有口令信封 */
    crypto.enablePassphrase(dir, 'correct-pass-1');
    const r = crypto.discardRawDek(dir, 'correct-pass-1', { confirm: true });
    assert.strictEqual(r.discarded, true);
    assert.strictEqual(r.credentialRemoved, true, '★ 凭据管理器里那条也得删掉，否则等于没拆');
    assert.strictEqual(crypto.keystore.hasSecret(dir), false, '凭据里不该还留着主密钥');
  });
});
