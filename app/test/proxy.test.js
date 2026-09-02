const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { resolveProxy } = require('../src/config');
const adapters = require('../src/adapters');

function withEnv(vars, fn) {
  const saved = {};
  const names = ['AKM_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
  names.forEach(n => { saved[n] = process.env[n]; delete process.env[n]; });
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    names.forEach(n => {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    });
  }
}

test('resolveProxy：AKM_PROXY 显式禁用与指定', () => {
  withEnv({ AKM_PROXY: 'off' }, () => {
    assert.strictEqual(resolveProxy(), null, 'off 应禁用代理');
  });
  withEnv({ AKM_PROXY: 'none' }, () => {
    assert.strictEqual(resolveProxy(), null);
  });
  withEnv({ AKM_PROXY: 'http://127.0.0.1:7897' }, () => {
    assert.strictEqual(resolveProxy(), 'http://127.0.0.1:7897');
  });
  withEnv({ AKM_PROXY: '127.0.0.1:7897' }, () => {
    assert.strictEqual(resolveProxy(), 'http://127.0.0.1:7897', '无协议前缀应自动补 http://');
  });
});

test('resolveProxy：环境变量回退顺序', () => {
  withEnv({ HTTPS_PROXY: 'http://env-proxy:8080' }, () => {
    assert.strictEqual(resolveProxy(), 'http://env-proxy:8080');
  });
  withEnv({ HTTP_PROXY: 'http://env-http:8080' }, () => {
    assert.strictEqual(resolveProxy(), 'http://env-http:8080');
  });
  withEnv({}, () => {
    // 无环境变量时回退 Windows 系统代理（本机开 Clash 时读到 http://127.0.0.1:7897），其他环境为 null
    const v = resolveProxy();
    assert.ok(v === null || /^http:\/\/.+/.test(v), '结果应为 null 或合法代理地址: ' + v);
  });
});

test('proxyFetch：代理拒绝 CONNECT 隧道时报明确错误', async () => {
  const server = http.createServer();
  server.on('connect', (req, clientSocket) => {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      () => adapters.proxyFetch('https://example.com/v1/models', {}, 'http://127.0.0.1:' + server.address().port),
      e => e.code === 'PROXY_REFUSED' && /拒绝建立隧道/.test(e.message)
    );
  } finally {
    server.close();
  }
});

test('proxyFetch：代理不可达时报代理连接错误', async () => {
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise(r => probe.close(r));
  await assert.rejects(
    () => adapters.proxyFetch('https://example.com/v1/models', {}, 'http://127.0.0.1:' + deadPort),
    e => e.code === 'PROXY_UNREACHABLE' && /无法连接代理/.test(e.message)
  );
});
