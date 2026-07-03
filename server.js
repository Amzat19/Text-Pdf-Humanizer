// AI Humanizer - local server. Thin HTTP dispatcher into lib/ops.js, the same
// core the Netlify Function uses, so `npm start` locally and the deployed site
// behave identically. The browser orchestrates multi-chunk work client-side.

const http = require('http');
const fs = require('fs');
const path = require('path');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) { /* no .env yet - mock mode */ }

const { ops, checkPassword } = require('./lib/ops');
const { isMock, listProviders } = require('./lib/llm');

const PORT = Number(process.env.PORT || 3777);
const MAX_BODY = 60 * 1024 * 1024;

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const POST_ROUTES = {
  'extract': p => ops.extract(p),
  'chunk': p => ops.chunk(p),
  'rewrite-chunk': p => ops.rewriteChunk(p),
  'judge': p => ops.judge(p),
  'analyze': p => ops.analyze(p),
  'docx-split': p => ops.docxSplit(p),
  'docx-rebuild': p => ops.docxRebuild(p),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    if (url.pathname.startsWith('/api/')) {
      if (!checkPassword(req.headers['x-app-password'])) {
        return sendJson(res, 401, { error: 'Password required', needPassword: true });
      }
      const route = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');

      if (req.method === 'GET' && route === 'config') return sendJson(res, 200, ops.config());

      const handler = POST_ROUTES[route];
      if (req.method === 'POST' && handler) {
        const raw = await readBody(req);
        let payload;
        try { payload = JSON.parse(raw.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
        const result = await handler(payload);
        return sendJson(res, 200, result);
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.statusCode || 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const ready = listProviders().filter(p => p.ready).map(p => p.label);
  console.log(`AI Humanizer running at http://localhost:${PORT}`);
  console.log(isMock()
    ? 'Mode: MOCK (no API key found - add a free key to .env, see .env.example)'
    : `Mode: LIVE (engines ready: ${ready.join(', ')})`);
  if (process.env.APP_PASSWORD) console.log('Password gate: ON');
});
