const path = require('node:path');
const pkg = require('./package.json');
const { createApp } = require('./src/app');
const config = require('./src/config');
const { vaultMode, unlockDek, MIN_PASSPHRASE } = require('./src/crypto');
const { createStore } = require('./src/storage');
const { createScheduler } = require('./src/scheduler');
const { createVaultSession, createThrottle } = require('./src/vault');

/* store 在解锁之前根本不存在：没 DEK 就不该有一个「能解密的对象」摆在进程里。
   外面这层门面负责把这件事说清楚——元信息照读（vault 路由要用 dataDir），
   任何真要取数据的调用在未解锁时抛 423，而不是返回半套空结果骗人。 */
let realStore = null;
function lockedError() {
  const e = new Error('保险库未解锁');
  e.httpStatus = 423;
  return e;
}
const storage = new Proxy({}, {
  get: function (_t, prop) {
    if (prop === 'dataDir') return config.dataDir;
    if (prop === 'backend') return realStore ? realStore.backend : null;
    if (prop === 'shadowStore') return realStore ? realStore.shadowStore : null;
    if (!realStore) throw lockedError();
    const v = realStore[prop];
    return typeof v === 'function' ? v.bind(realStore) : v;
  },
  has: function (_t, prop) { return !!realStore && prop in realStore; }
});

const vault = createVaultSession({ idleLockMs: config.idleLockMs });
const throttle = {
  unlock: createThrottle({ maxFails: 5 }),
  reveal: createThrottle({ maxFails: 30 }),
  credential: createThrottle({ maxFails: 20 })
};
const scheduler = createScheduler({
  storage: storage,
  enabled: config.schedule.enabled,
  intervalMinutes: config.schedule.intervalMinutes
});

let schedulerStarted = false;
function startScheduler() {
  if (schedulerStarted) return null;
  schedulerStarted = true;
  return scheduler.start();
}

function openStore(dek, mode) {
  /* 注意：每次解锁都会 createStore 一次，而 store 目前没有 close()，SQLite 句柄要等进程
     退出才释放。真人一次开机解一两次无所谓；测试里反复锁解要留意 Windows 上的临时目录删除。 */
  realStore = createStore(config.dataDir, dek);
  vault.attach(dek, mode);
  /* 定时调度只在解锁之后才排第一轮：锁着的时候跑一轮只会每 60 分钟记一条 423 */
  if (config.schedule.enabled) startScheduler();
  return realStore;
}

function closeStore() {
  const had = !!realStore;
  realStore = null;
  if (schedulerStarted) { scheduler.stop(); schedulerStarted = false; }
  return had;
}

/* 开机三条路：没设过口令（legacy，照旧免密自启）／设了且环境变量给了口令（直接解）
   ／设了但没给口令（起服务、只放行 vault 路由，等界面解锁）。 */
var bootError = null;
const mode = vaultMode(config.dataDir);
let bootState = 'locked';
if (mode === 'legacy') {
  const b = unlockDek(config.dataDir);
  openStore(b.dek, b.mode);
  bootState = 'legacy';
} else {
  const envPw = String(process.env.AKM_PASSPHRASE || '');
  if (envPw.length >= MIN_PASSPHRASE) {
    try {
      const b = unlockDek(config.dataDir, envPw);
      openStore(b.dek, b.mode);
      bootState = 'envelope';
    } catch (e) {
      bootState = 'bad-env-passphrase';
      bootError = e.message;
    }
  }
}
if (bootState === 'bad-env-passphrase') {
  /* AKM_PASSPHRASE 错了不能当成「等界面解锁」——那会让 systemd/计划任务以为服务健康，
     而它其实每次都解不开。非交互环境里直接失败退出，让监督进程看得见。 */
  if (process.stdin && !process.stdin.isTTY) {
    console.error('启动失败：AKM_PASSPHRASE 无法解开 ' + config.dataDir + ' 里的保险库（' + bootError + '）。');
    process.exit(1);
  }
  bootState = 'locked';
}

const app = createApp({
  storage: storage,
  publicDir: path.join(__dirname, 'public'),
  version: pkg.version,
  scheduler: scheduler,
  vault: vault,
  throttle: throttle,
  onUnlock: openStore,
  onLock: closeStore
});

app.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + config.port + ' 已被占用：可能已有一个 API-AegisLens 在运行。');
    console.error('请直接用浏览器访问 http://127.0.0.1:' + config.port + '，或用环境变量 AKM_PORT 换端口。');
    process.exit(1);
  }
  console.error('启动失败：' + e.message);
  process.exit(1);
});

app.listen(config.port, '127.0.0.1', function () {
  console.log('');
  console.log('  API-AegisLens v' + pkg.version + ' 已启动');
  console.log('  浏览器访问: http://127.0.0.1:' + config.port);
  console.log('  数据目录: ' + config.dataDir);
  if (bootState === 'locked') {
    console.log('  保险库状态: 已锁定 —— 解锁前所有密钥与凭证接口都返回 423，只有 /api/vault/* 可用');
    console.log('  请在浏览器里输入解锁口令；忘了就用恢复码在同一个界面重置');
  } else {
    console.log('  存储后端: ' + realStore.backend + '（密钥字段 AES-256-GCM 加密）');
    console.log('  保险库状态: ' + (bootState === 'legacy'
      ? '免密（未设解锁口令；设了之后重启即要求解锁）'
      : '已由 AKM_PASSPHRASE 解锁'));
    const sched = scheduler.status();
    console.log('  定时调度: ' + (sched.enabled
      ? '开启，每 ' + sched.intervalMinutes + ' 分钟跑一轮密钥测试 + 余额刷新；POST /api/schedule 可关可改间隔，重启后回到此默认'
      : '关闭（AKM_SCHEDULE_ENABLED=1 或 POST /api/schedule {"enabled":true} 开启）'));
  }
  console.log('  停止服务: 在本窗口按 Ctrl+C');
  console.log('');
});
