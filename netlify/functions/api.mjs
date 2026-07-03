// Netlify Function entry point - claims /api/* directly (Functions 2.0 path
// config, no redirects needed). Thin dispatcher into the shared op core;
// the browser orchestrates multi-chunk work with one short call per chunk.
import opsModule from '../../lib/ops.js';

const { ops, checkPassword } = opsModule;

export const config = { path: '/api/*' };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');

  if (!checkPassword(req.headers.get('x-app-password'))) {
    return json({ error: 'Password required', needPassword: true }, 401);
  }

  try {
    if (req.method === 'GET' && route === 'config') return json(ops.config());
    if (req.method !== 'POST') return json({ error: 'Not found' }, 404);

    const payload = await req.json().catch(() => { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); });

    switch (route) {
      case 'extract':       return json(await ops.extract(payload));
      case 'chunk':         return json(ops.chunk(payload));
      case 'rewrite-chunk': return json(await ops.rewriteChunk(payload));
      case 'judge':         return json(await ops.judge(payload));
      case 'analyze':       return json(ops.analyze(payload));
      case 'docx-split':    return json(await ops.docxSplit(payload));
      case 'docx-rebuild':  return json(await ops.docxRebuild(payload));
      default:              return json({ error: 'Not found' }, 404);
    }
  } catch (err) {
    return json({ error: err.message }, err.statusCode || 500);
  }
};
