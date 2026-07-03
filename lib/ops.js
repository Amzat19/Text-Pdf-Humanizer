// Shared operation core. Both entry points - the local Node server (server.js)
// and the Netlify Function (netlify/functions/api.mjs) - dispatch into these.
// Every op is a short, single-purpose call so it fits inside serverless time
// limits; the BROWSER orchestrates multi-chunk work (pools of rewrite/judge
// calls), which is also what gives the UI real progress.
//
// Errors meant for the client carry .statusCode; everything else is a 500.

const { extractText } = require('./extract');
const { chunkText, chunkSelective } = require('./chunker');
const { buildSystemPrompt, TONES, STRENGTHS } = require('./prompt');
const { rewriteChunk, judgeText, isMock, resolveProvider, listProviders } = require('./llm');
const { analyzeDoc } = require('./metrics');
const { splitForRewrite, rebuildWithReplacements } = require('./docx-rewrite');

const MAX_TEXT_CHARS = 400_000;
const MAX_FILE_B64 = 8 * 1024 * 1024; // ~6MB binary - Netlify's function payload ceiling

function bad(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

function readText(payload) {
  const text = String(payload.text || '').trim();
  if (!text) throw bad(400, 'No text provided');
  if (text.length > MAX_TEXT_CHARS) throw bad(413, `Text too long (max ${MAX_TEXT_CHARS.toLocaleString()} chars)`);
  return text;
}

function readFileBuffer(payload) {
  const b64 = String(payload.fileB64 || '');
  if (!b64) throw bad(400, 'No file provided');
  if (b64.length > MAX_FILE_B64) throw bad(413, 'File too large for hosted mode (~6MB max)');
  try { return Buffer.from(b64, 'base64'); } catch { throw bad(400, 'Bad base64 payload'); }
}

// Resolve the engine for a request; throws a clean 400 when the named engine
// has no key. Returns null in mock mode (callers then run their mock path).
function resolveEngine(payload) {
  if (isMock()) return null;
  const requested = payload.provider ? String(payload.provider).slice(0, 40) : null;
  const chosen = resolveProvider(requested);
  if (requested && !chosen) throw bad(400, `Engine "${requested}" has no API key configured`);
  return chosen;
}

const ops = {
  config() {
    return {
      mock: isMock(),
      providers: listProviders(),
      tones: Object.fromEntries(Object.entries(TONES).map(([k, v]) => [k, v.label])),
      strengths: Object.fromEntries(Object.entries(STRENGTHS).map(([k, v]) => [k, v.label])),
    };
  },

  async extract(payload) {
    const buffer = readFileBuffer(payload);
    const filename = String(payload.filename || 'pasted.txt');
    const text = await extractText(buffer, filename);
    if (!text) throw bad(422, 'No text could be extracted from this file');
    return {
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS,
      chars: text.length,
      words: (text.match(/\S+/g) || []).length,
    };
  },

  chunk(payload) {
    const text = readText(payload);
    const keep = Array.isArray(payload.keep)
      ? new Set(payload.keep.map(Number).filter(Number.isInteger))
      : null;
    const chunks = keep ? chunkSelective(text, keep) : chunkText(text);
    return { chunks };
  },

  async rewriteChunk(payload) {
    const text = readText(payload);
    const tone = TONES[payload.tone] ? payload.tone : 'natural';
    const strength = STRENGTHS[payload.strength] ? payload.strength : 'standard';
    const voiceSample = String(payload.voiceSample || '').slice(0, 4000);
    const chosen = resolveEngine(payload);
    const model = String(payload.model || (chosen ? chosen.defaultModel : '')).slice(0, 120);
    const system = buildSystemPrompt({ tone, strength, voiceSample });
    const r = await rewriteChunk({
      text, system, model,
      temperature: STRENGTHS[strength].temperature,
      provider: chosen,
    });
    return { rewritten: r.rewritten, usage: r.usage, mock: r.mock };
  },

  async judge(payload) {
    const text = readText(payload);
    const chosen = resolveEngine(payload);
    if (!chosen) return { skipped: true };
    const model = String(payload.model || chosen.defaultModel).slice(0, 120);
    const j = await judgeText({ text, provider: chosen, model });
    return { score: j.score, reasons: j.reasons };
  },

  analyze(payload) {
    const text = readText(payload);
    const doc = analyzeDoc(text);
    return {
      mock: isMock(),
      overall: doc.overall,
      paragraphs: doc.paragraphs.map(p => ({
        index: p.index, text: p.text, words: p.words,
        score: p.score, verdict: p.verdict, reasons: p.reasons,
      })),
    };
  },

  async docxSplit(payload) {
    const buffer = readFileBuffer(payload);
    const paragraphs = await splitForRewrite(buffer);
    return { total: paragraphs.length, paragraphs };
  },

  async docxRebuild(payload) {
    const buffer = readFileBuffer(payload);
    const replacements = payload.replacements && typeof payload.replacements === 'object'
      ? payload.replacements : {};
    const result = await rebuildWithReplacements(buffer, replacements);
    return { fileB64: result.buffer.toString('base64'), stats: result.stats };
  },
};

// Password gate shared by both entry points. Gate is active only when
// APP_PASSWORD is set (so local dev stays frictionless).
function checkPassword(headerValue) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true;
  return headerValue === pw;
}

module.exports = { ops, checkPassword };
