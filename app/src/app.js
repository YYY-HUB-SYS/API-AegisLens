const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { apiRouter } = require('./api');
const { createVaultSession, createThrottle } = require('./vault');

/* 只放行这几种后缀：不在表里的扩展名一律 404，避免 /vendor/ 变成任意文件读取口 */
const VENDOR_TYPES = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/* 凭证视图是独立文件（为了不和 index.html 抢同一把写锁），但只列举这两个，
   不放开整个 public 目录——否则数据目录之外的任意文件读取口子又开了一条 */
const APP_ASSETS = {
  '/credentials-view.js': 'text/javascript; charset=utf-8',
  '/credentials-view.css': 'text/css; charset=utf-8'
};

function pathnameOf(url) {
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  let p = q === -1 ? url : url.slice(0, q);
  if (h !== -1) p = p.slice(0, h);
  return p;
}

function createApp(opts) {
  const storage = opts.storage;
  const fetchImpl = opts.fetchImpl;
  const version = opts.version || '0.0.0';
  const publicDir = opts.publicDir;
  const vendorRoot = path.resolve(publicDir, 'vendor');

  /* 没显式注入会话时按「免密老安装」开：现有安装的行为一字不改，
     设过口令之后由 server.js 注入一个锁着的会话。DEK 交给会话持有，
     免密与口令两条解密路径因此是同一套，不留特判 */
  const vault = opts.vault || createVaultSession({ idleLockMs: opts.idleLockMs });
  if (!opts.vault) vault.openLegacy(opts.dek);
  const throttle = opts.throttle || {
    unlock: createThrottle({ maxFails: 5 }),
    reveal: createThrottle({ maxFails: 30 }),
    /* 凭证取用单独一档：和 Key 的 reveal 共用额度会让人搞不清是被谁限的 */
    credential: createThrottle({ maxFails: 20 }),
    /* 签发新令牌单独一档：解锁窗口内任何本机进程都能调签发接口（和 reveal 同一个信任前提），
       不设额度就等于允许一个脚本一分钟造出几百把有效令牌，吊销列表先被撑爆 */
    token: createThrottle({ maxFails: 20 })
  };
  /* 外部注入的 throttle 对象是 server.js 自己拼的，键少一个就会在签发时撞成 TypeError。
     在这里补齐而不是两边各写一遍：新增一档只改这一处。 */
  if (!throttle.token) throttle.token = createThrottle({ maxFails: 20 });

  /* 闲置自动锁的驱动。不 unref 的话测试里 createApp 之后进程会挂住不退出；
     免密模式下 lockIfIdle 恒为 false，这个定时器留着不做事也无害。
     锁上时必须连 store 一起关掉：只清会话不关 store，界面写着「已锁定」而进程照样能解密，
     那就是装样子 */
  const onLock = opts.onLock || function () { return vault.lock(); };
  const idleTimer = setInterval(function () {
    if (vault.lockIfIdle()) onLock();
  }, opts.idleLockTickMs || 30000);
  if (idleTimer.unref) idleTimer.unref();

  /* 命中应用自带的静态资产返回 true（已自行应答） */
  function serveAppAsset(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const type = APP_ASSETS[pathnameOf(req.url)];
    if (!type) return false;
    const abs = path.resolve(publicDir, pathnameOf(req.url).slice(1));
    if (!abs.startsWith(path.resolve(publicDir))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return true;
    }
    fs.readFile(abs, function (err, buf) {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return true;
  }

  let indexHtml = null;
  try {
    indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'));
  } catch (e) { /* index.html 缺失时由下方 500 分支提示 */ }

  /* 命中 /vendor/ 返回 true（已自行应答），否则 false 交给后续路由 */
  function serveVendor(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const pathname = pathnameOf(req.url);
    if (!pathname.startsWith('/vendor/')) return false;

    let rel;
    try {
      rel = decodeURIComponent(pathname.slice('/vendor/'.length));
    } catch (e) {
      rel = null;
    }
    if (rel === null || rel.indexOf('\u0000') !== -1 || path.isAbsolute(rel)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return true;
    }

    const abs = path.resolve(vendorRoot, rel);
    if (abs !== vendorRoot && !abs.startsWith(vendorRoot + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return true;
    }

    const type = VENDOR_TYPES[path.extname(abs).toLowerCase()];
    if (!type) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return true;
    }

    fs.readFile(abs, function (err, buf) {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return true;
  }

  return http.createServer(function (req, res) {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      if (!indexHtml) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('index.html 缺失');
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(indexHtml);
    }
    if (serveAppAsset(req, res)) return;
    if (serveVendor(req, res)) return;
    if (req.url.startsWith('/api/')) {
      return apiRouter(req, res, {
        storage: storage,
        fetchImpl: fetchImpl,
        version: version,
        scheduler: opts.scheduler || null,
        vault: vault,
        throttle: throttle,
        /* 解锁/锁定不只是改会话状态：store 的建与关归宿主（server.js）管，
           没注入时退化成「只动会话」，测试里用得上 */
        onUnlock: opts.onUnlock || function (dek, m) { vault.attach(dek, m); },
        onLock: onLock
      });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

module.exports = { createApp: createApp };
