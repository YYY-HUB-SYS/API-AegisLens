const path = require('node:path');
const pkg = require('./package.json');
const { createApp } = require('./src/app');
const config = require('./src/config');
const { loadOrCreateMasterKey } = require('./src/crypto');
const { createStore } = require('./src/storage');

const masterKey = loadOrCreateMasterKey(config.dataDir);
const storage = createStore(config.dataDir, masterKey);
const app = createApp({
  storage: storage,
  publicDir: path.join(__dirname, 'public'),
  version: pkg.version
});

app.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + config.port + ' 已被占用：可能已有一个 AI Key Manager 在运行。');
    console.error('请直接用浏览器访问 http://127.0.0.1:' + config.port + '，或用环境变量 AKM_PORT 换端口。');
    process.exit(1);
  }
  console.error('启动失败：' + e.message);
  process.exit(1);
});

app.listen(config.port, '127.0.0.1', function () {
  console.log('');
  console.log('  AI Key Manager v' + pkg.version + ' 已启动');
  console.log('  浏览器访问: http://127.0.0.1:' + config.port);
  console.log('  数据目录: ' + config.dataDir);
  console.log('  存储后端: ' + storage.backend + '（密钥字段 AES-256-GCM 加密）');
  console.log('  停止服务: 在本窗口按 Ctrl+C');
  console.log('');
});
