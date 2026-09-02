const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { apiRouter } = require('./api');

function createApp(opts) {
  const storage = opts.storage;
  const fetchImpl = opts.fetchImpl;
  const version = opts.version || '0.0.0';
  const publicDir = opts.publicDir;

  let indexHtml = null;
  try {
    indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'));
  } catch (e) { /* index.html 缺失时由下方 500 分支提示 */ }

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
    if (req.url.startsWith('/api/')) {
      return apiRouter(req, res, { storage: storage, fetchImpl: fetchImpl, version: version });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

module.exports = { createApp: createApp };
