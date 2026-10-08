/* 凭证保险库的存储层。两个后端（node:sqlite 与 store.json）跑同一组断言，最后再把同一套
   操作在两条后端上留下的整份轨迹逐字对一次 —— models.extra 那次只改了 SQLite 一侧、
   漏了 JSON 一侧，排查了很久，这里就是要让那种漏法当场红。
   存储层自己不碰加解密：四个 *_enc 列密文进密文出，所以这组测试连主密钥都用不上。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/storage');

const BACKENDS = [];
try {
  require('node:sqlite');
  BACKENDS.push('sqlite');
} catch (e) { /* 当前 Node 没有 node:sqlite，只跑 JSON 后端 */ }
BACKENDS.push('json');

const MASTER = Buffer.alloc(32, 7);
const TIME_FIELDS = ['createdAt', 'updatedAt', 'lastUsedAt'];
const RECORD_FIELDS = ['id', 'title', 'username', 'url', 'folder', 'tags',
  'passwordEnc', 'secretEnc', 'totpEnc', 'noteEnc', 'createdAt', 'updatedAt', 'lastUsedAt'];

/* 四段假密文：形状照 crypto.encryptField 的输出，内容随意。存储层要是敢动它们，
   「原样存取」那组断言当场就会发现 */
const ENC = {
  passwordEnc: 'enc:v1:Zm9vYmFyYmF6AQID',
  secretEnc: 'enc:v1:c3VwZXItc2VjcmV0LXN0dWY=',
  totpEnc: 'enc:v1:amZOR0hKS0xNQU5PcHFS',
  noteEnc: 'enc:v1:5L2g5aW977yM6LWE5L6nJDk5OTk='
};

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-' + prefix + '-')); }

/* store 没有 close()，SQLite 句柄要等进程退出才释放，Windows 上目录因此删不掉；清理尽力而为 */
function sweep(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 句柄未释放，留给 OS */ }
}

function store(dir, backend) { return createStore(dir, MASTER, { backend: backend }); }

/* 时间戳是 nowIso() 现取的，两条后端不可能落在同一毫秒，对轨迹时先抹成占位符；
   真值在 checkShape 里逐个查是 ISO 串还是 null */
function maskTimes(rec) {
  if (!rec) return rec;
  const out = Object.assign({}, rec);
  TIME_FIELDS.forEach(function (f) { if (out[f] != null) out[f] = '<time>'; });
  return out;
}

/* 期望值照 credRecord() 的字段顺序搭，这样 JSON.stringify 出来的轨迹串才可逐字比 */
function rec(over) {
  const base = {
    id: 1, title: '', username: '', url: '', folder: '', tags: '',
    passwordEnc: null, secretEnc: null, totpEnc: null, noteEnc: null,
    createdAt: '<time>', updatedAt: '<time>', lastUsedAt: null
  };
  return Object.assign(base, over || {});
}

function isIso(v, what) {
  assert.strictEqual(typeof v, 'string', what + ' 该是字符串时间戳');
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v), what + ' 该是 nowIso() 那种 ISO 串：' + v);
}

function checkShape(whatever, label) {
  const r = whatever;
  assert.deepStrictEqual(Object.keys(r), RECORD_FIELDS, label + '：两个后端的记录形状与字段顺序必须一致');
  isIso(r.createdAt, label + '.createdAt');
  isIso(r.updatedAt, label + '.updatedAt');
  if (r.lastUsedAt !== null) isIso(r.lastUsedAt, label + '.lastUsedAt');
}

/* nowIso() 只到毫秒，连着两次写可能落在同一毫秒里；比较「时间戳动没动」之前先让时钟走出去 */
function bumpClock() {
  const t = Date.now();
  while (Date.now() <= t + 2) { /* 忙等，别在测试里塞 setTimeout 把断言推到下一个 tick */ }
}

function fullCredential(over) {
  return Object.assign({
    title: 'GitHub 工作号',
    username: 'dev@example.com',
    url: 'https://github.com/login',
    folder: '工作',
    tags: '代码,托管'
  }, ENC, over || {});
}

const ids = function (list) { return list.map(function (r) { return r.id; }); };

BACKENDS.forEach(function (backend) {

  test(backend + ' 后端：凭证 CRUD、更新、touch、lastUsed、删除各走一遍', () => {
    const dir = tmp('cred-crud-' + backend);
    try {
      const s = store(dir, backend);
      assert.strictEqual(s.backend, backend, '指定了后端就得是那个后端');

      const created = s.createCredential(fullCredential());
      checkShape(created, 'createCredential');
      assert.strictEqual(typeof created.id, 'number', 'id 是数字不是字符串');
      assert.ok(created.id >= 1);
      assert.strictEqual(created.lastUsedAt, null, '没用过就是 null');
      assert.strictEqual(created.createdAt, created.updatedAt, '新建时两个戳同一时刻');

      const got = s.getCredential(created.id);
      assert.deepStrictEqual(got, created, '按 id 取回来的应与插入返回的完全一样');
      assert.strictEqual(s.getCredential(created.id + 500), null, '查不到给 null 不抛');

      const second = s.createCredential({ title: '第二条', username: 'bob' });
      checkShape(second, '第二条');
      assert.strictEqual(second.id, created.id + 1);
      assert.deepStrictEqual(ids(s.listCredentials()), [created.id, second.id], '全量取按 id 排序');

      bumpClock();
      const upd = s.updateCredential(created.id, { title: '改名了', username: 'moe@example.com' });
      assert.strictEqual(upd.title, '改名了');
      assert.strictEqual(upd.username, 'moe@example.com');
      assert.strictEqual(upd.url, created.url, '补丁没带的字段不该被动');
      assert.strictEqual(upd.folder, created.folder);
      assert.strictEqual(upd.tags, created.tags);
      assert.strictEqual(upd.passwordEnc, created.passwordEnc);
      assert.strictEqual(upd.createdAt, created.createdAt, '更新不许碰 created_at');
      assert.notStrictEqual(upd.updatedAt, created.updatedAt, '更新要刷新 updated_at');

      bumpClock();
      const touched = s.touchCredential(created.id);
      assert.notStrictEqual(touched.updatedAt, upd.updatedAt, 'touch 就是改 updated_at');
      assert.strictEqual(touched.createdAt, created.createdAt, 'touch 不许碰 created_at');
      assert.strictEqual(touched.title, '改名了', 'touch 不该动内容');

      bumpClock();
      const used = s.setCredentialLastUsed(created.id);
      assert.ok(used.lastUsedAt, 'setLastUsed 写上时间戳');
      assert.strictEqual(used.updatedAt, touched.updatedAt, '「用过一次」不是改动记录，updated_at 不该动');
      assert.strictEqual(used.createdAt, created.createdAt);

      assert.strictEqual(s.deleteCredential(created.id), true);
      assert.strictEqual(s.getCredential(created.id), null);
      assert.strictEqual(s.deleteCredential(created.id), false, '删不存在的行返回 false');
      assert.strictEqual(s.updateCredential(created.id, { title: 'x' }), null);
      assert.strictEqual(s.touchCredential(created.id), null);
      assert.strictEqual(s.setCredentialLastUsed(created.id), null);
      assert.deepStrictEqual(ids(s.listCredentials()), [second.id]);
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：四个 *_enc 列原样存取，密文进密文出', () => {
    const dir = tmp('cred-enc-' + backend);
    try {
      const s = store(dir, backend);
      const rec2 = s.createCredential(fullCredential());
      const ENC_FIELDS = ['passwordEnc', 'secretEnc', 'totpEnc', 'noteEnc'];
      ENC_FIELDS.forEach(function (f) {
        assert.strictEqual(rec2[f], ENC[f], f + ' 该原样返回');
        assert.ok(rec2[f].indexOf('enc:v1:') === 0, f + ' 前缀不许被改写');
      });

      const back = s.getCredential(rec2.id);
      ENC_FIELDS.forEach(function (f) {
        assert.strictEqual(back[f], ENC[f], f + ' 读回来还是一个字节都没动');
      });

      bumpClock();
      const moved = 'enc:v1:5pys5ZGI56GX5LqG5ZGK54ix';
      const upd = s.updateCredential(rec2.id, { passwordEnc: moved });
      assert.strictEqual(upd.passwordEnc, moved);
      assert.strictEqual(upd.secretEnc, ENC.secretEnc, '改一个密文不该惊动别的密文列');

      /* 不带 enc:v1: 前缀的值也照原样存 —— 解不解、验不验是 api 层的事，这层不做判断 */
      const plain = s.createCredential({
        title: '未加密', username: 'plain',
        passwordEnc: 'hunter2', secretEnc: '', totpEnc: null, noteEnc: '随手记'
      });
      assert.strictEqual(plain.passwordEnc, 'hunter2', '非前缀串不报错也不改写');
      assert.strictEqual(plain.secretEnc, '', '空串保空串（encryptField 对空值就返回空串）');
      assert.strictEqual(plain.totpEnc, null, 'null 保 null，表示这一项没录');
      assert.strictEqual(plain.noteEnc, '随手记');
      assert.strictEqual(plain.title, '未加密');

      /* 真落盘：换个 store 实例读同一个目录，密文照旧 */
      const again = store(dir, backend).getCredential(rec2.id);
      assert.strictEqual(again.passwordEnc, moved, '更新后的密文穿过持久层');
      ENC_FIELDS.slice(1).forEach(function (f) {
        assert.strictEqual(again[f], ENC[f], f + ' 穿过持久层没变形');
      });

      const raw = fs.readFileSync(path.join(dir, backend === 'sqlite' ? 'keys.db' : 'store.json')).toString('latin1');
      assert.ok(raw.includes(ENC.secretEnc), '落盘文件里就是那段密文本身');
      assert.ok(raw.includes(moved), '更新后的密文也在文件里');
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：空表、超长字段、tags 带逗号/中文、title 留空', () => {
    const dir = tmp('cred-edge-' + backend);
    try {
      const s = store(dir, backend);
      assert.deepStrictEqual(s.listCredentials(), [], '空表读到空数组不是报错');
      assert.deepStrictEqual(s.credentialUsernameCounts(), [], '空表没有账号可数');
      assert.strictEqual(s.getCredential(1), null);
      assert.strictEqual(s.deleteCredential(1), false);
      assert.strictEqual(s.touchCredential(1), null);

      const bare = s.createCredential();
      checkShape(bare, '不带参数');
      assert.strictEqual(bare.title, '', 'title 留空存空串，不是 null');
      assert.deepStrictEqual(
        [bare.username, bare.url, bare.folder, bare.tags], ['', '', '', ''], '明文列缺省一律空串');
      assert.deepStrictEqual(
        [bare.passwordEnc, bare.secretEnc, bare.totpEnc, bare.noteEnc],
        [null, null, null, null], '密文列缺省一律 null');

      const long = '长'.repeat(30000) + 'a'.repeat(20000);
      const big = s.createCredential({
        title: '', username: 'long-user', url: 'https://e.com/' + 'p'.repeat(5000),
        folder: '超大', tags: long, passwordEnc: 'enc:v1:' + long
      });
      assert.strictEqual(big.tags.length, long.length, 'tags 超长原样存');
      const bigBack = s.getCredential(big.id);
      assert.strictEqual(bigBack.url.length, 'https://e.com/'.length + 5000);
      assert.strictEqual(bigBack.passwordEnc, 'enc:v1:' + long, '超长密文一字节没丢');
      assert.strictEqual(bigBack.noteEnc, null);

      const oddTags = '朋友,家人，重要,🎉,  带空格  ,含"引号",含\'单引号\',含\\反斜杠,含\n换行';
      const odd = s.createCredential({ title: '标签怪', username: 'tagger', tags: oddTags });
      assert.strictEqual(s.getCredential(odd.id).tags, oddTags,
        'tags 就是一段文本：逗号、中文逗号、emoji、引号、反斜杠、换行都不该被拆开或转义');

      /* id 传字符串：JSON 侧本来就存数字，SQLite 靠列亲和自己转，两条后端都得命中 */
      assert.ok(s.getCredential(String(odd.id)), '字符串 id 也认');
      assert.strictEqual(s.getCredential('abc'), null, '非数字 id 当查不到，不该抛');
      assert.strictEqual(s.getCredential(null), null);
      assert.strictEqual(s.updateCredential(String(odd.id), { folder: '  ' }).folder, '  ',
        '空格不是空：不许悄悄 trim');

      /* id 与三个时间戳由存储层管，补丁塞进来也不认 */
      const guarded = s.updateCredential(odd.id, {
        id: 99999, createdAt: '1999-01-01T00:00:00.000Z',
        updatedAt: '1999-01-01T00:00:00.000Z', lastUsedAt: '1999-01-01T00:00:00.000Z'
      });
      assert.strictEqual(guarded.id, odd.id, 'id 不可改');
      assert.notStrictEqual(guarded.createdAt, '1999-01-01T00:00:00.000Z', 'created_at 不可改');
      assert.notStrictEqual(guarded.updatedAt, '1999-01-01T00:00:00.000Z', 'updated_at 由存储层现取');
      assert.strictEqual(guarded.lastUsedAt, null, 'last_used_at 只走 setCredentialLastUsed');

      /* 入参 snake_case（照表列名写）与 camelCase（照记录形状写）都认，出参一律 camelCase */
      const aliased = s.createCredential({ title: '别名', password_enc: ENC.passwordEnc, note_enc: ENC.noteEnc });
      assert.strictEqual(aliased.passwordEnc, ENC.passwordEnc, 'password_enc 该落到 passwordEnc');
      assert.strictEqual(aliased.noteEnc, ENC.noteEnc, 'note_enc 同上');
      assert.strictEqual(aliased.secretEnc, null);
      const aliasedUpd = s.updateCredential(aliased.id, { totp_enc: ENC.totpEnc });
      assert.strictEqual(aliasedUpd.totpEnc, ENC.totpEnc, '补丁里的 snake_case 也认');
      assert.strictEqual(aliasedUpd.passwordEnc, ENC.passwordEnc, '别名补丁不该冲掉别的密文列');
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：删除后 id 不复用、行不残留', () => {
    const dir = tmp('cred-ids-' + backend);
    try {
      const s = store(dir, backend);
      const a = s.createCredential({ title: 'A', username: 'same' });
      const b = s.createCredential({ title: 'B', username: 'same' });
      const c = s.createCredential({ title: 'C', username: 'solo' });
      assert.deepStrictEqual(ids([a, b, c]), [1, 2, 3], 'id 从 1 起连续');

      assert.strictEqual(s.deleteCredential(c.id), true);
      const d = s.createCredential({ title: 'D', username: 'solo' });
      assert.strictEqual(d.id, 4, 'AUTOINCREMENT 语义：删掉最大 id 也不回退复用');
      assert.deepStrictEqual(ids(s.listCredentials()), [1, 2, 4], '3 号不残留');
      assert.strictEqual(s.getCredential(c.id), null);

      /* 中间行删除：留下的行不受影响，也不会「补位」改号 */
      assert.strictEqual(s.deleteCredential(b.id), true);
      assert.deepStrictEqual(ids(s.listCredentials()), [1, 4]);
      assert.deepStrictEqual(s.listCredentials().map(maskTimes), [maskTimes(a), maskTimes(d)],
        '幸存行不该被删除动作改写');
      assert.strictEqual(s.getCredential(b.id), null);
      const e = s.createCredential({ title: 'E', username: 'bob' });
      assert.strictEqual(e.id, 5, '空洞不回填');

      /* 换个 store 实例重开同一目录：号段继续往前走，删掉的行不会从库里爬回来 */
      const reopened = store(dir, backend);
      assert.deepStrictEqual(ids(reopened.listCredentials()), [1, 4, 5], '重启后不留残行');
      assert.strictEqual(reopened.getCredential(b.id), null, '重启后也不该看得见');
      assert.strictEqual(reopened.getCredential(c.id), null);
      const f = reopened.createCredential({ title: 'F', username: 'frank' });
      assert.strictEqual(f.id, 6, '重启后 id 继续递增，不复用 2 或 3');
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：credentialUsernameCounts 给出同一 username 出现在几条记录里', () => {
    const dir = tmp('cred-counts-' + backend);
    try {
      const s = store(dir, backend);
      const three = [
        s.createCredential({ title: 'T1', username: 'shared' }),
        s.createCredential({ title: 'T2', username: 'shared' }),
        s.createCredential({ title: 'T3', username: 'shared' })
      ];
      const once = s.createCredential({ title: 'T4', username: 'once' });
      /* 空白账号不计数：否则每条没填 username 的记录都被判成「复用」，那是噪声不是信号 */
      s.createCredential({ title: 'T5', username: '' });
      s.createCredential({ title: 'T6' });
      s.createCredential({ title: 'T7', username: null });
      /* 大小写与前后空格都不归一：归一方式稍有差别，两个后端就会各自判出不同的组 */
      s.createCredential({ title: 'T8', username: 'Shared' });
      s.createCredential({ title: 'T9', username: ' shared' });
      const zh = s.createCredential({ title: 'T10', username: '中文账号' });

      assert.deepStrictEqual(s.credentialUsernameCounts(), [
        { username: ' shared', count: 1 },
        { username: 'Shared', count: 1 },
        { username: 'once', count: 1 },
        { username: 'shared', count: 3 },
        { username: '中文账号', count: 1 }
      ], '按码位升序给出条数（空格排最前、大写排小写前、中文排最后），空白不计数');

      assert.deepStrictEqual(s.credentialUsernameCounts().filter(function (r) { return r.count > 1; }),
        [{ username: 'shared', count: 3 }], '复用检测只看这一条');

      bumpClock();
      s.updateCredential(once.id, { username: 'shared' });
      assert.deepStrictEqual(s.credentialUsernameCounts().filter(function (r) { return r.username === 'shared'; }),
        [{ username: 'shared', count: 4 }], '改账号后计数跟着走');

      s.deleteCredential(three[0].id);
      assert.deepStrictEqual(s.credentialUsernameCounts().filter(function (r) { return r.username === 'shared'; }),
        [{ username: 'shared', count: 3 }], '删掉的行不留在计数里');
      assert.strictEqual(store(dir, backend).credentialUsernameCounts().length, 4, '重开目录计数一致');

      s.deleteCredential(zh.id);
      assert.deepStrictEqual(s.credentialUsernameCounts().filter(function (r) { return r.username === '中文账号'; }), [],
        '删除后中文账号也从计数里走干净');
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：凭证与密钥互不干扰，重启后都在', () => {
    const dir = tmp('cred-coexist-' + backend);
    try {
      const s = store(dir, backend);
      const key = s.createKey({
        name: '共存', platform: 'deepseek', customName: '', key: 'sk-coexist-0001',
        base: 'https://api.deepseek.com', model: 'deepseek-chat', reg: '', exp: ''
      });
      const cred = s.createCredential(fullCredential());
      assert.strictEqual(s.listKeys().length, 1);
      assert.strictEqual(s.listCredentials().length, 1);

      const s2 = store(dir, backend);
      assert.strictEqual(s2.listKeys().length, 1, '凭证写进老目录不该动密钥');
      assert.strictEqual(s2.listCredentials().length, 1);
      assert.strictEqual(s2.getCredential(cred.id).passwordEnc, ENC.passwordEnc);
      assert.strictEqual(s2.getKey(key.id).key, 'sk-coexist-0001');
      assert.strictEqual(s2.deleteKey(key.id), true);
      assert.strictEqual(s2.listCredentials().length, 1, '删密钥不该带走凭证');
      assert.strictEqual(s2.deleteCredential(cred.id), true);
      assert.strictEqual(s2.listKeys().length, 0);
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：老库没有 credentials 这张表时补建', () => {
    const dir = tmp('cred-legacy-' + backend);
    try {
      const a = store(dir, backend);
      a.createCredential(fullCredential());
      const kept = a.createKey({
        name: '旧密钥', platform: 'openai', customName: '', key: 'sk-legacy-0002',
        base: 'https://api.openai.com/v1', model: 'gpt-4o', reg: '', exp: ''
      });
      if (backend === 'json') {
        const file = path.join(dir, 'store.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        delete data.credentials;
        delete data.nextCredentialId;
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } else {
        const { DatabaseSync } = require('node:sqlite');
        const raw = new DatabaseSync(path.join(dir, 'keys.db'));
        raw.exec('DROP TABLE credentials');
        raw.close();
      }

      const b = store(dir, backend);
      assert.strictEqual(b.getKey(kept.id).key, 'sk-legacy-0002', '旧库的密钥记录照旧读得出');
      assert.deepStrictEqual(b.listCredentials(), [], '补建前读不出旧凭证，但不能报错');
      const again = b.createCredential({ title: '补建后', username: 'newcomer' });
      assert.ok(again.id >= 1, '新行照样写得出');
      assert.deepStrictEqual(b.credentialUsernameCounts(), [{ username: 'newcomer', count: 1 }]);
      assert.strictEqual(b.listKeys().length, 1, '补表不该惊动密钥');
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：只填了一半的行，两条后端读出同一套缺省', () => {
    const dir = tmp('cred-partial-' + backend);
    try {
      store(dir, backend); /* 先把表建出来，再绕过存储层塞一条只有 title 的行 */
      if (backend === 'json') {
        const file = path.join(dir, 'store.json');
        /* JSON 后端只在写操作时才落盘，先走一次公开写入把文件造出来 */
        store(dir, backend).createCredential({ title: '占位' });
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        data.credentials = [{ id: 1, title: '只填了标题' }];
        data.nextCredentialId = 2;
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } else {
        const { DatabaseSync } = require('node:sqlite');
        const raw = new DatabaseSync(path.join(dir, 'keys.db'));
        raw.exec("INSERT INTO credentials (id, title) VALUES (1, '只填了标题')");
        raw.close();
      }

      const s = store(dir, backend);
      assert.deepStrictEqual(s.getCredential(1), {
        id: 1, title: '只填了标题', username: '', url: '', folder: '', tags: '',
        passwordEnc: null, secretEnc: null, totpEnc: null, noteEnc: null,
        createdAt: null, updatedAt: null, lastUsedAt: null
      }, '缺的列：明文补空串、密文与时间戳补 null，两条后端一个字都不差');
      assert.deepStrictEqual(s.credentialUsernameCounts(), [], '空白 username 进不了计数');

      const upd = s.updateCredential(1, { username: 'zoe' });
      assert.strictEqual(upd.username, 'zoe');
      assert.strictEqual(upd.createdAt, null, '补写不发明 created_at');
      isIso(upd.updatedAt, '半成品行的 updated_at');
      const used = s.setCredentialLastUsed(1);
      isIso(used.lastUsedAt, '半成品行的 last_used_at');
      assert.deepStrictEqual(maskTimes(s.getCredential(1)), maskTimes(used));
    } finally { sweep(dir); }
  });
});

/* 两条后端跑同一套操作，把整份轨迹逐字对一次：行内容、id 顺序、每步返回值都不许有分歧 */
test('sqlite 与 json 两条后端：同一套操作的轨迹完全一致', () => {
  if (BACKENDS.indexOf('sqlite') < 0) return; /* 这台 Node 没有 node:sqlite，无从对照 */
  const transcript = {};
  BACKENDS.forEach(function (backend) {
    const dir = tmp('cred-parity-' + backend);
    try { transcript[backend] = exercise(store(dir, backend)); } finally { sweep(dir); }
  });

  const expected = [
    'create ' + JSON.stringify(rec(fullCredential())),
    'listIds [1]',
    'second ' + JSON.stringify(rec({ id: 2 })),
    'getById ' + JSON.stringify(rec(fullCredential())),
    'updated ' + JSON.stringify(rec(Object.assign(fullCredential(), { username: 'moe@example.com' }))),
    'listIds [1,2]',
    'touchedMoved true',
    'lastUsed before=null set=true updatedAtUntouched=true createdAtUntouched=true',
    'counts [{"username":"moe@example.com","count":1},{"username":"zoe","count":2}]',
    'delete true',
    'deleteAgain false',
    'getDeleted null',
    'listIds [2,4]',
    'thirdId 5',
    'countsAfter [{"username":"zoe","count":2}]',
    'shape ' + RECORD_FIELDS.join(',')
  ];
  assert.deepStrictEqual(transcript.sqlite, expected, 'SQLite 侧轨迹就是这份');
  assert.deepStrictEqual(transcript.json, expected, 'JSON 侧轨迹就是同一份');
  assert.deepStrictEqual(transcript.sqlite, transcript.json, '两条后端逐字一致');
});

function exercise(s) {
  const t = [];
  const j = function (v) { return JSON.stringify(maskTimes(v)); };

  const created = s.createCredential(fullCredential());
  t.push('create ' + j(created));
  t.push('listIds ' + JSON.stringify(ids(s.listCredentials())));

  const second = s.createCredential({ title: '', username: '' });
  t.push('second ' + j(second));
  t.push('getById ' + j(s.getCredential(created.id)));

  bumpClock();
  t.push('updated ' + j(s.updateCredential(created.id, { username: 'moe@example.com' })));
  t.push('listIds ' + JSON.stringify(ids(s.listCredentials())));

  bumpClock();
  const touched = s.touchCredential(created.id);
  t.push('touchedMoved ' + (touched.updatedAt !== created.updatedAt));

  bumpClock();
  const before = s.getCredential(created.id);
  const used = s.setCredentialLastUsed(created.id);
  t.push('lastUsed before=' + (before.lastUsedAt === null ? 'null' : 'set')
    + ' set=' + (!!used.lastUsedAt)
    + ' updatedAtUntouched=' + (used.updatedAt === before.updatedAt)
    + ' createdAtUntouched=' + (used.createdAt === before.createdAt));

  const zoe1 = s.createCredential({ title: 'Z1', username: 'zoe' });
  s.createCredential({ title: 'Z2', username: 'zoe' });
  t.push('counts ' + JSON.stringify(s.credentialUsernameCounts()));

  t.push('delete ' + s.deleteCredential(created.id));
  t.push('deleteAgain ' + s.deleteCredential(created.id));
  t.push('getDeleted ' + JSON.stringify(s.getCredential(created.id)));
  s.deleteCredential(zoe1.id);
  t.push('listIds ' + JSON.stringify(ids(s.listCredentials())));
  t.push('thirdId ' + s.createCredential({ title: '第三', username: 'zoe' }).id);
  t.push('countsAfter ' + JSON.stringify(s.credentialUsernameCounts()));
  t.push('shape ' + Object.keys(s.getCredential(second.id)).join(','));
  return t;
}
