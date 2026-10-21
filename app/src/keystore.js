/* 系统凭据管理器（Windows Credential Manager / macOS Keychain / libsecret）适配层。
 *
 * 为什么有这层：主密钥（master.key）原先是**盘上明文 hex**。
 * 那个文件放在用户目录里，Windows 上的 `mode: 0o600` 几乎不产生 ACL 效果，
 * 于是「拷走整个目录」就等于「拷走全部密钥」——本项目主打本地加密，
 * 在自己的主战平台上这条防线却是最薄的一环。
 *
 * 这里是**可选增强**，不是硬依赖：
 *   - 本项目承诺 `git clone` 之后不用 `npm install` 就能跑（零依赖），
 *     所以 `@napi-rs/keyring` 只能作为 optionalDependency，装了就用、没装就退回原行为；
 *   - 凭据管理器不可用时（Linux 无 libsecret、容器内、无头环境、装了但原生模块加载失败）
 *     一律**静默退回文件模式**，绝不能让「装不上凭据管理器」变成「服务起不来」。
 *
 * 两种模式并存时的判断由 crypto.js 负责（看 master.key 的文件头），本模块只管存取。 */

const fs = require('node:fs');
const path = require('node:path');

/* 凭据管理器里的条目名：要能认出是本项目，但不能和别的软件撞。
   服务名 + 数据目录的绝对路径 ⇒ 同一台机器上多个数据目录互不干扰。 */
const SERVICE = 'API-AegisLens';

let keyring = null;
let keyringTried = false;

/* 加载 @napi-rs/keyring：装了才加载，没装（或加载失败）就当没有这回事。
   任何异常都吞掉——这一层的失败绝不能冒泡到服务启动路径上。 */
function loadKeyring() {
  if (keyringTried) return keyring;
  keyringTried = true;
  try {
    /* eslint-disable-next-line global-require */
    const mod = require('@napi-rs/keyring');
    keyring = (mod && typeof mod.getPassword === 'function') ? mod : null;
  } catch (e) {
    keyring = null;
  }
  return keyring;
}

/* 条目名按数据目录区分：同一个服务名下多份数据目录要各有各的主密钥。 */
function entryName(dataDir) {
  return SERVICE + ':' + path.resolve(dataDir);
}

/* 凭据管理器是否真的能用：装了模块 ≠ 能访问（无头 Linux 没有 dbus/keyring daemon，
   装了照样读写失败）。所以这里要真写一次再删掉，而不是只看模块在不在。 */
let availability = null;
function isAvailable(dataDir) {
  if (availability !== null) return availability;
  const kr = loadKeyring();
  if (!kr) { availability = false; return false; }
  /* 只探测「不依赖具体数据目录」的通用性：用一个临时条目名试写试删。
     真正的存取失败会在 set/get 里单独处理。 */
  const probe = SERVICE + ':probe:' + process.pid;
  try {
    kr.setPassword(probe, 'probe');
    const back = kr.getPassword(probe);
    kr.deletePassword(probe);
    availability = (back === 'probe');
  } catch (e) {
    availability = false;
  }
  return availability;
}

/* 读主密钥：返回 Buffer(32) 或 null（没这条凭据）。
   出错时返回 null 而不是抛——上层会据此回退到文件模式。 */
function getSecret(dataDir) {
  const kr = loadKeyring();
  if (!kr) return null;
  try {
    const raw = kr.getPassword(entryName(dataDir));
    if (!raw) return null;
    const buf = Buffer.from(raw, 'hex');
    return buf.length === 32 ? buf : null;
  } catch (e) {
    return null;
  }
}

/* 写主密钥：成功返回 true，失败返回 false（上层退回文件模式）。 */
function setSecret(dataDir, secret) {
  const kr = loadKeyring();
  if (!kr) return false;
  try {
    kr.setPassword(entryName(dataDir), Buffer.from(secret).toString('hex'));
    return true;
  } catch (e) {
    return false;
  }
}

/* 删主密钥（数据目录被删除、或用户要「降回文件模式」时用）。 */
function deleteSecret(dataDir) {
  const kr = loadKeyring();
  if (!kr) return false;
  try {
    kr.deletePassword(entryName(dataDir));
    return true;
  } catch (e) {
    return false;
  }
}

/* 这个数据目录当前是否在用凭据管理器。 */
function hasSecret(dataDir) {
  return getSecret(dataDir) !== null;
}

/* 给界面看的一句话状态：凭据管理器能不能用、这个目录是不是在用它。 */
function describe(dataDir) {
  const available = isAvailable(dataDir);
  return {
    available: available,
    inUse: available ? hasSecret(dataDir) : false,
    service: SERVICE
  };
}

/* 探测用的临时条目清理（进程退出时尽力而为）。 */
function cleanupProbe() {
  const kr = loadKeyring();
  if (!kr) return;
  try { kr.deletePassword(SERVICE + ':probe:' + process.pid); } catch (e) { /* 清理失败无所谓 */ }
}

module.exports = {
  SERVICE,
  isAvailable: isAvailable,
  getSecret: getSecret,
  setSecret: setSecret,
  deleteSecret: deleteSecret,
  hasSecret: hasSecret,
  describe: describe,
  cleanupProbe: cleanupProbe
};
