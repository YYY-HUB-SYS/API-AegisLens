/* 后台化与单实例哨兵：解决「双击 start.bat 弹一个 cmd 窗口，窗口一关服务就没了」。
   只做进程管理，不碰加解密——DEK 该不该在后台常驻由 server.js 的不变量决定。 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PID_FILENAME = 'server.pid';

function pidPath(dataDir) { return path.join(dataDir, PID_FILENAME); }

function writePid(dataDir, info) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pidPath(dataDir), JSON.stringify(Object.assign({ pid: process.pid }, info)) + '\n', { mode: 0o600 });
}

function readPid(dataDir) {
  const p = pidPath(dataDir);
  if (!fs.existsSync(p)) return null;
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { corrupt: true };
  }
  if (!obj || !Number.isInteger(obj.pid)) return { corrupt: true };
  return obj;
}

function clearPid(dataDir, pid) {
  const cur = readPid(dataDir);
  /* 只删自己写的那份：另一个实例可能已经接管了同一个 pid 文件 */
  if (cur && !cur.corrupt && (pid === undefined || cur.pid === pid)) {
    try { fs.unlinkSync(pidPath(dataDir)); } catch (e) { /* 已被删 */ }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/* pid 会被操作系统复用，单看号码会误判「还在跑」。所以号码之外还要端口对得上；
   两者都中才认定是同一个实例。判不出来时宁可报「不确定」也不静默起第二个。 */
function runningInstance(dataDir, port) {
  const info = readPid(dataDir);
  if (!info) return null;
  if (info.corrupt) return { corrupt: true };
  if (!alive(info.pid)) return null;
  if (port !== undefined && info.port !== port) return null;
  return info;
}

function spawnDaemon(opts) {
  const o = opts || {};
  const child = spawn(o.execPath || process.execPath, [o.script].concat(o.args || []), {
    cwd: o.cwd,
    env: o.env || process.env,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return child.pid;
}

function stopInstance(dataDir, port) {
  const info = runningInstance(dataDir, port);
  if (!info) return { stopped: false, reason: 'not-running' };
  if (info.corrupt) return { stopped: false, reason: 'corrupt' };
  try {
    process.kill(info.pid);
  } catch (e) {
    return { stopped: false, reason: 'kill-failed', message: e.message };
  }
  clearPid(dataDir, info.pid);
  return { stopped: true, pid: info.pid };
}

module.exports = {
  PID_FILENAME,
  pidPath,
  writePid,
  readPid,
  clearPid,
  alive,
  runningInstance,
  spawnDaemon,
  stopInstance
};
