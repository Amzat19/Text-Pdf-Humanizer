// AI Humanizer - local server. Everything runs on this machine; the only
// outbound call is the LLM API request itself (none in mock mode).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) { /* no .env yet - mock mode */ }

const { extractText } = require('./lib/extract');
const { chunkText, chunkSelective } = require('./lib/chunker');
const { buildSystemPrompt, TONES, STRENGTHS } = require('./lib/prompt');
const { rewriteChunk, judgeText, isMock, resolveProvider, listProviders } = require('./lib/llm');
const { analyze, analyzeDoc, verdictFor } = require('./lib/metrics');
const { rewriteDocx, countRewritable } = require('./lib/docx-rewrite');

const PORT = Number(process.env.PORT || 3777);
const HISTORY_DIR = path.join(__dirname, 'data', 'history');
const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;
const CHUNK_CONCURRENCY = 3;

fs.mkdirSync(HISTORY_DIR, { recursive: true });

// ---------- helpers ----------

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > limit) {
        reject(new Error(`Body too large (limit ${Math.round(limit / 1024 / 1024)}MB)`));
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
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function historyPath(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Bad history id');
  return path.join(HISTORY_DIR, `${id}.json`);
}

async function mapPool(items, concurrency, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// ---------- route handlers ----------

async function handleExtract(req, res) {
  const filename = decodeURIComponent(req.headers['x-filename'] || 'pasted.txt');
  const buffer = await readBody(req);
  if (!buffer.length) return sendJson(res, 400, { error: 'Empty file' });
  const text = await extractText(buffer, filename);
  if (!text) return sendJson(res, 422, { error: 'No text could be extracted from this file' });
  sendJson(res, 200, {
    text: text.slice(0, MAX_TEXT_CHARS),
    truncated: text.length > MAX_TEXT_CHARS,
    chars: text.length,
    words: (text.match(/\S+/g) || []).length,
  });
}

async function handleHumanize(req, res) {
  const raw = await readBody(req, 5 * 1024 * 1024);
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }

  const text = String(payload.text || '').trim();
  if (!text) return sendJson(res, 400, { error: 'No text provided' });
  if (text.length > MAX_TEXT_CHARS) return sendJson(res, 413, { error: `Text too long (max ${MAX_TEXT_CHARS.toLocaleString()} chars)` });

  const tone = TONES[payload.tone] ? payload.tone : 'natural';
  const strength = STRENGTHS[payload.strength] ? payload.strength : 'standard';

  // Engine choice: the UI sends a provider name; reject cleanly if that
  // provider has no key rather than silently rewriting with a different one.
  let chosen = null;
  if (!isMock()) {
    const requested = payload.provider ? String(payload.provider).slice(0, 40) : null;
    chosen = resolveProvider(requested);
    if (requested && !chosen) {
      return sendJson(res, 400, { error: `Engine "${requested}" has no API key configured in .env` });
    }
  }

  const model = String(payload.model || (chosen ? chosen.defaultModel : '')).slice(0, 120);
  const voiceSample = String(payload.voiceSample || '').slice(0, 4000);

  const system = buildSystemPrompt({ tone, strength, voiceSample });
  const temperature = STRENGTHS[strength].temperature;
  // Selective mode: paragraph indices in `keep` pass through untouched
  const keep = Array.isArray(payload.keep)
    ? new Set(payload.keep.map(Number).filter(Number.isInteger))
    : null;
  const chunks = keep ? chunkSelective(text, keep) : chunkText(text);
  const started = Date.now();

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const emit = obj => res.write(JSON.stringify(obj) + '\n');

  emit({ type: 'meta', chunks: chunks.length, model, provider: chosen ? chosen.label : 'mock', mock: isMock(), tone, strength });

  const results = new Array(chunks.length);
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let failedChunks = 0;
  let fatalError = null;

  await mapPool(chunks, CHUNK_CONCURRENCY, async chunk => {
    if (fatalError) {
      results[chunk.index] = chunk.text;
      return;
    }
    if (!chunk.rewritable) {
      results[chunk.index] = chunk.text;
      emit({ type: 'chunk', index: chunk.index, original: chunk.text, rewritten: chunk.text, rewritable: false });
      return;
    }
    try {
      const r = await rewriteChunk({ text: chunk.text, system, model, temperature, provider: chosen });
      results[chunk.index] = r.rewritten;
      usage.prompt_tokens += r.usage.prompt_tokens || 0;
      usage.completion_tokens += r.usage.completion_tokens || 0;
      emit({ type: 'chunk', index: chunk.index, original: chunk.text, rewritten: r.rewritten, rewritable: true });
    } catch (err) {
      failedChunks++;
      results[chunk.index] = chunk.text; // pass original through so the doc stays whole
      emit({ type: 'chunk_error', index: chunk.index, original: chunk.text, error: err.message });
      if (err.fatal) fatalError = err;
    }
  });

  const output = results.join('\n\n');
  const metrics = { before: analyze(text), after: analyze(output) };
  const elapsedMs = Date.now() - started;

  let historyId = null;
  try {
    historyId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(historyPath(historyId), JSON.stringify({
      id: historyId,
      ts: new Date().toISOString(),
      settings: { tone, strength, model, provider: chosen ? chosen.name : 'mock', voiceSample: voiceSample ? true : false, mock: isMock() },
      chunks: chunks.length,
      failedChunks,
      elapsedMs,
      usage,
      metrics,
      input: text,
      output,
    }, null, 2));
  } catch (_) { /* history is best-effort */ }

  emit({
    type: 'done',
    elapsedMs,
    usage,
    failedChunks,
    fatal: fatalError ? fatalError.message : null,
    metrics,
    historyId,
  });
  res.end();
}

// "How human does this read?" - instant local heuristics per paragraph,
// then (when an engine is live) an AI-judge second opinion streamed per
// paragraph. NDJSON: heuristics -> judge* -> done.
async function handleAnalyze(req, res) {
  const raw = await readBody(req, 5 * 1024 * 1024);
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }

  const text = String(payload.text || '').trim();
  if (!text) return sendJson(res, 400, { error: 'No text provided' });
  if (text.length > MAX_TEXT_CHARS) return sendJson(res, 413, { error: `Text too long (max ${MAX_TEXT_CHARS.toLocaleString()} chars)` });

  let chosen = null;
  const deep = payload.deep !== false;
  if (deep && !isMock()) {
    const requested = payload.provider ? String(payload.provider).slice(0, 40) : null;
    chosen = resolveProvider(requested);
    if (requested && !chosen) {
      return sendJson(res, 400, { error: `Engine "${requested}" has no API key configured in .env` });
    }
  }
  const model = String(payload.model || (chosen ? chosen.defaultModel : '')).slice(0, 120);

  const doc = analyzeDoc(text);

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const emit = obj => res.write(JSON.stringify(obj) + '\n');

  emit({
    type: 'heuristics',
    judging: Boolean(chosen),
    overall: doc.overall,
    paragraphs: doc.paragraphs.map(p => ({
      index: p.index, text: p.text, words: p.words,
      score: p.score, verdict: p.verdict, reasons: p.reasons,
    })),
  });

  const judged = new Map();
  let judgeFailed = 0;
  let fatalError = null;
  if (chosen) {
    const targets = doc.paragraphs.filter(p => p.score !== null);
    await mapPool(targets, CHUNK_CONCURRENCY, async p => {
      if (fatalError) return;
      try {
        const j = await judgeText({ text: p.text, provider: chosen, model });
        if (j) {
          judged.set(p.index, j.score);
          emit({ type: 'judge', index: p.index, score: j.score, reasons: j.reasons });
        }
      } catch (err) {
        judgeFailed++;
        emit({ type: 'judge_error', index: p.index, error: err.message });
        if (err.fatal) fatalError = err;
      }
    });
  }

  // Blended doc score: word-weighted mean of per-paragraph finals
  // (final = 35% heuristic + 65% judge when a judge score exists).
  const scored = doc.paragraphs.filter(p => p.score !== null);
  const totalWords = scored.reduce((a, p) => a + p.words, 0) || 1;
  const blended = scored.length
    ? Math.round(scored.reduce((a, p) => {
        const j = judged.get(p.index);
        const final = j == null ? p.score : Math.round(0.35 * p.score + 0.65 * j);
        return a + final * p.words;
      }, 0) / totalWords)
    : null;
  const judgedParas = scored.filter(p => judged.has(p.index));
  const judgedWords = judgedParas.reduce((a, p) => a + p.words, 0) || 1;
  const judgeAvg = judgedParas.length
    ? Math.round(judgedParas.reduce((a, p) => a + judged.get(p.index) * p.words, 0) / judgedWords)
    : null;

  emit({
    type: 'done',
    overall: {
      heuristic: doc.overall.score,
      judge: judgeAvg,
      blended,
      verdict: verdictFor(blended ?? doc.overall.score),
      reasons: doc.overall.reasons,
    },
    judgeFailed,
    fatal: fatalError ? fatalError.message : null,
  });
  res.end();
}

// Document Mode: .docx in -> same .docx out with styles/tables/images/layout
// preserved and prose paragraphs humanized. NDJSON: meta -> progress* -> file.
async function handleHumanizeDocx(req, res) {
  const raw = await readBody(req, 60 * 1024 * 1024);
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }

  if (!payload.fileB64) return sendJson(res, 400, { error: 'No file provided' });
  let buffer;
  try { buffer = Buffer.from(String(payload.fileB64), 'base64'); } catch { return sendJson(res, 400, { error: 'Bad base64 payload' }); }

  const tone = TONES[payload.tone] ? payload.tone : 'natural';
  const strength = STRENGTHS[payload.strength] ? payload.strength : 'standard';

  let chosen = null;
  if (!isMock()) {
    const requested = payload.provider ? String(payload.provider).slice(0, 40) : null;
    chosen = resolveProvider(requested);
    if (requested && !chosen) {
      return sendJson(res, 400, { error: `Engine "${requested}" has no API key configured in .env` });
    }
  }
  const model = String(payload.model || (chosen ? chosen.defaultModel : '')).slice(0, 120);
  const voiceSample = String(payload.voiceSample || '').slice(0, 4000);
  const system = buildSystemPrompt({ tone, strength, voiceSample });
  const temperature = STRENGTHS[strength].temperature;
  const started = Date.now();

  let total;
  try { total = await countRewritable(buffer); }
  catch (err) { return sendJson(res, 422, { error: err.message }); }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const emit = obj => res.write(JSON.stringify(obj) + '\n');
  emit({ type: 'meta', paragraphs: total, provider: chosen ? chosen.label : 'mock', mock: isMock(), tone, strength });

  let fatalError = null;
  try {
    const result = await rewriteDocx(buffer, async text => {
      if (fatalError) return null;
      try {
        const r = await rewriteChunk({ text, system, model, temperature, provider: chosen });
        return r.rewritten;
      } catch (err) {
        if (err.fatal) fatalError = err;
        throw err;
      }
    }, {
      concurrency: CHUNK_CONCURRENCY,
      onProgress: (done, n) => emit({ type: 'progress', done, total: n }),
    });

    const safeName = String(payload.filename || 'document.docx').replace(/[^\w.\- ]+/g, '').replace(/^.*[\\/]/, '') || 'document.docx';
    emit({
      type: 'file',
      filename: 'humanized-' + safeName,
      b64: result.buffer.toString('base64'),
      stats: result.stats,
      mock: isMock(),
      fatal: fatalError ? fatalError.message : null,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    emit({ type: 'error', error: err.message });
  }
  res.end();
}

function listHistory() {
  const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
  const items = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
      items.push({
        id: j.id,
        ts: j.ts,
        preview: (j.input || '').slice(0, 110),
        words: j.metrics?.before?.wordCount || 0,
        scoreBefore: j.metrics?.before?.score ?? null,
        scoreAfter: j.metrics?.after?.score ?? null,
        settings: j.settings,
      });
    } catch (_) { /* skip corrupt entries */ }
  }
  items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return items.slice(0, 50);
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return sendJson(res, 200, {
        mock: isMock(),
        providers: listProviders(),
        tones: Object.fromEntries(Object.entries(TONES).map(([k, v]) => [k, v.label])),
        strengths: Object.fromEntries(Object.entries(STRENGTHS).map(([k, v]) => [k, v.label])),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/extract') return await handleExtract(req, res);
    if (req.method === 'POST' && url.pathname === '/api/humanize') return await handleHumanize(req, res);
    if (req.method === 'POST' && url.pathname === '/api/analyze') return await handleAnalyze(req, res);
    if (req.method === 'POST' && url.pathname === '/api/humanize-docx') return await handleHumanizeDocx(req, res);
    if (req.method === 'GET' && url.pathname === '/api/history') return sendJson(res, 200, { items: listHistory() });

    const historyMatch = url.pathname.match(/^\/api\/history\/([a-z0-9-]+)$/i);
    if (historyMatch) {
      const file = historyPath(historyMatch[1]);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Not found' });
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(fs.readFileSync(file));
        return;
      }
      if (req.method === 'DELETE') {
        fs.unlinkSync(file);
        return sendJson(res, 200, { ok: true });
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const ready = listProviders().filter(p => p.ready).map(p => p.label);
  console.log(`AI Humanizer running at http://localhost:${PORT}`);
  console.log(isMock()
    ? 'Mode: MOCK (no API key found - add a free key to .env, see .env.example)'
    : `Mode: LIVE (engines ready: ${ready.join(', ')})`);
});
