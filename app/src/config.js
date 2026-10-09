const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

/* 闲置自动锁的间隔。以前 server.js 读的是 config.idleLockMs，而这个字段压根不存在，
   于是它永远 undefined、静默落回 vault.js 的 5 分钟——看起来可配，其实不可配。
   现在它是真的可配；不设时返回 undefined，让 vault.js 的默认值当唯一权威，
   免得两处各写一个「5 分钟」以后互相漂。 */
function readIdleLockMs() {
  const raw = String(process.env.AKM_IDLE_LOCK_MINUTES || '').trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 60000);
}

const dataDir = process.env.AKM_DATA_DIR
  ? path.resolve(process.env.AKM_DATA_DIR)
  : path.join(os.homedir(), '.api-aegislens');

const port = Number(process.env.AKM_PORT || 37700);

/* 默认只绑回环。AKM_BIND 可以放开到局域网，但放开之后「必须先有解锁口令」这条
   不变量由 server.js 把关——这里只负责把地址规范化并说清它算不算回环。
   0.0.0.0 / :: 是「所有网卡」，不是回环。 */
function normalizeBind(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return '127.0.0.1';
  return v.replace(/^\[/, '').replace(/\]$/, '');
}

function isLoopbackBind(b) {
  return b === '127.0.0.1' || b === 'localhost' || b === '::1';
}

const bind = normalizeBind(process.env.AKM_BIND);

function normalizeProxyUrl(raw) {
  let v = String(raw).trim();
  if (!v) return null;
  if (/^(off|none|direct|0|false)$/i.test(v)) return null;
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  return v;
}

function readRegValue(name) {
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ' + name,
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const m = out.match(new RegExp(name + '\\s+REG_[A-Z_]+\\s+(\\S+)'));
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

/* 代理优先级：AKM_PROXY（off/none 禁用）> HTTPS_PROXY 等环境变量 > Windows 系统代理注册表 > 直连。
   Agent Router 等境外中转站必须走代理才可达，而 Node 的 fetch 不读系统代理，故自动检测。 */
function resolveProxy() {
  const explicit = process.env.AKM_PROXY;
  if (explicit !== undefined) return normalizeProxyUrl(explicit);

  const env = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (env) return normalizeProxyUrl(env);

  if (process.platform === 'win32') {
    const enabled = readRegValue('ProxyEnable');
    if (enabled === '0x1') {
      const server = readRegValue('ProxyServer');
      if (server) {
        // 可能是 "127.0.0.1:7897" 或 "http=a:80;https=b:80;ftp=c:21" 分协议格式
        const parts = String(server).split(';');
        const httpsPart = parts.find(function (p) { return /^https=/i.test(p); });
        const candidate = httpsPart ? httpsPart.replace(/^https=/i, '') : parts[0];
        if (candidate && candidate.trim()) return normalizeProxyUrl(candidate.trim());
      }
    }
  }
  return null;
}

const proxy = resolveProxy();

/* 定时调度默认关：一旦开启，服务每次活着的时候都会周期性朝全部厂商发真实请求，
   这件事得用户自己点（AKM_SCHEDULE_ENABLED 或界面上的开关）。
   间隔只认分钟，上下限由 api.js 那对常量夹住，这里不做二次判断。 */
const SCHEDULE_DEFAULT_INTERVAL_MINUTES = 60;

function readScheduleConfig() {
  const flag = String(process.env.AKM_SCHEDULE_ENABLED || '').trim().toLowerCase();
  const raw = Number(process.env.AKM_SCHEDULE_INTERVAL_MINUTES);
  return {
    enabled: flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes',
    intervalMinutes: Number.isFinite(raw) && raw > 0 ? raw : SCHEDULE_DEFAULT_INTERVAL_MINUTES
  };
}

module.exports = {
  dataDir,
  port,
  bind,
  isLoopbackBind,
  normalizeBind,
  proxy,
  resolveProxy,
  idleLockMs: readIdleLockMs(),
  schedule: readScheduleConfig()
};
