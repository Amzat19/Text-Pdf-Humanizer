// Provider-agnostic LLM client (OpenAI-compatible chat completions).
// Multiple providers can be configured at once (one key each in .env);
// the UI exposes every configured engine and the request picks one per run.
// All the free-tier providers below need no credit card.
// Falls back to mock mode (regex AI-ism swaps) when no key is configured.

const PROVIDERS = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    keyEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct'],
  },
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyEnv: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1/chat/completions',
    keyEnv: 'CEREBRAS_API_KEY',
    defaultModel: 'llama-3.3-70b',
    models: ['llama-3.3-70b', 'llama3.1-8b'],
  },
  custom: {
    label: 'Custom',
    baseUrl: null, // read from LLM_BASE_URL at resolve time (works for local Ollama too)
    keyEnv: 'LLM_API_KEY',
    defaultModel: null, // read from LLM_MODEL
    models: [],
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    keyEnv: 'OPENROUTER_API_KEY',
    defaultModel: 'anthropic/claude-haiku-4.5',
    models: ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5', 'openai/gpt-4o-mini', 'google/gemini-2.5-flash'],
    // Reasoning-family models on OpenRouter burn the whole budget "thinking"
    // and return empty content unless this is off.
    extraBody: { reasoning: { enabled: false } },
    extraHeaders: { 'HTTP-Referer': 'http://localhost', 'X-Title': 'AI Humanizer (local)' },
  },
};

const RECOMMENDED = 'groq';
const DETECT_ORDER = ['groq', 'gemini', 'cerebras', 'custom', 'openrouter'];

function providerReady(name) {
  const p = PROVIDERS[name];
  if (!p) return false;
  if (!process.env[p.keyEnv]) return false;
  if (name === 'custom' && !process.env.LLM_BASE_URL) return false;
  return true;
}

function buildProvider(name) {
  const p = PROVIDERS[name];
  return {
    name,
    label: p.label,
    baseUrl: name === 'custom' ? process.env.LLM_BASE_URL : p.baseUrl,
    apiKey: process.env[p.keyEnv],
    keyEnv: p.keyEnv,
    defaultModel: name === 'custom' ? (process.env.LLM_MODEL || 'llama3.2') : p.defaultModel,
    models: name === 'custom' ? [process.env.LLM_MODEL || 'llama3.2'] : p.models,
    extraBody: p.extraBody || {},
    extraHeaders: p.extraHeaders || {},
  };
}

// With a preferred name: that provider if its key is configured, else null (no
// silent fallback - the caller surfaces the error). Without: first ready one.
function resolveProvider(preferred) {
  if (preferred) {
    const name = String(preferred).toLowerCase().trim();
    return PROVIDERS[name] && providerReady(name) ? buildProvider(name) : null;
  }
  const name = DETECT_ORDER.find(providerReady);
  return name ? buildProvider(name) : null;
}

function isMock() {
  return process.env.MOCK_LLM === '1' || !resolveProvider();
}

// Everything the UI needs to render the engine picker. The three free
// providers always appear (grayed out until their key lands); custom and
// openrouter only appear once configured.
function listProviders() {
  const visible = ['groq', 'gemini', 'cerebras'];
  if (providerReady('custom')) visible.push('custom');
  if (providerReady('openrouter')) visible.push('openrouter');
  return visible.map(name => {
    const b = buildProvider(name);
    return {
      name,
      label: b.label,
      ready: providerReady(name),
      recommended: name === RECOMMENDED,
      keyEnv: b.keyEnv,
      defaultModel: b.defaultModel,
      models: b.models,
    };
  });
}

// ---------- mock engine ----------

const MOCK_SWAPS = [
  [/\bdelved into\b/gi, 'dug into'],
  [/\bdelve into\b/gi, 'dig into'],
  [/\bleverage\b/gi, 'use'],
  [/\butilize\b/gi, 'use'],
  [/\bMoreover,\s*/g, 'And '],
  [/\bFurthermore,\s*/g, 'Also, '],
  [/\bAdditionally,\s*/g, 'Also, '],
  [/\bit'?s important to note that\s*/gi, 'note that '],
  [/\bseamless\b/gi, 'smooth'],
  [/\brobust\b/gi, 'solid'],
  [/\bIn today's fast-paced world,?\s*/gi, ''],
  [/\bin conclusion,?\s*/gi, ''],
  [/\bempower(s|ed|ing)?\b/gi, 'help$1'],
];

function mockRewrite(text) {
  let out = text;
  for (const [pattern, replacement] of MOCK_SWAPS) out = out.replace(pattern, replacement);
  return out;
}

// ---------- real engine ----------

function maxTokensFor(text) {
  const approxInputTokens = Math.ceil(text.length / 4);
  return Math.max(800, Math.min(4096, Math.ceil(approxInputTokens * 1.5) + 400));
}

const RETRIABLE = new Set([408, 429, 500, 502, 503, 504, 522, 524]);

// Shared OpenAI-compatible completion call with retry/backoff/timeout.
async function chatComplete({ provider, model, messages, temperature, maxTokens, responseFormat }) {
  const payload = {
    model: model || provider.defaultModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    ...provider.extraBody,
  };
  if (responseFormat) payload.response_format = responseFormat;
  const body = JSON.stringify(payload);

  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const res = await fetch(provider.baseUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
          ...provider.extraHeaders,
        },
        body,
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        throw Object.assign(
          new Error(`${provider.label} rejected the API key (HTTP ${res.status}). Check ${provider.keyEnv} in .env.`),
          { fatal: true }
        );
      }
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        const err = new Error(`${provider.label} HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
        err.status = res.status;
        if (!RETRIABLE.has(res.status)) err.fatal = true;
        throw err;
      }

      const data = await res.json();
      if (data.error) {
        throw Object.assign(new Error(`${provider.label} error: ${data.error.message || JSON.stringify(data.error).slice(0, 300)}`), { fatal: true });
      }
      const content = data.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        const reason = data.choices?.[0]?.finish_reason || 'unknown';
        throw new Error(`Model returned empty content (finish_reason: ${reason}). Try another model.`);
      }
      return { content: content.trim(), usage: data.usage || {} };
    } catch (err) {
      lastError = err;
      if (err.fatal || attempt === 4) break;
      // 429s on free tiers are per-minute windows - back off harder for those
      const wait = err.status === 429 ? attempt * 7000 : attempt * 2000;
      await new Promise(r => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function rewriteChunk({ text, system, model, temperature, provider }) {
  if (isMock() || !provider) {
    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
    return { rewritten: mockRewrite(text), usage: { prompt_tokens: 0, completion_tokens: 0 }, mock: true };
  }
  const r = await chatComplete({
    provider,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
    temperature: temperature ?? 0.8,
    maxTokens: maxTokensFor(text),
  });
  return { rewritten: r.content, usage: r.usage, mock: false };
}

// ---------- AI judge: "how human does this read?" ----------
// A second opinion on top of the local heuristics. Directional, not a
// detector - the model rates typical AI-prose fingerprints it can see.

const JUDGE_SYSTEM = `You judge whether a passage reads like typical AI-assistant prose or like natural human writing. You are scoring STYLE fingerprints, not guessing authorship with certainty.

AI-prose fingerprints: uniform sentence rhythm, tidy parallel structures everywhere, formula transitions, hedging fillers, generic intensifiers, bloodless abstract nouns, over-balanced "on one hand / on the other" framing, suspiciously consistent paragraph shapes, zero specifics, cheerful summary endings.

Human fingerprints: uneven rhythm, concrete details and numbers a generic writer wouldn't invent, opinionated word choices, asides, mild informality or friction, sentences that take a small risk.

Return ONLY JSON, no other text:
{"score": <integer 0-100, where 100 = reads unmistakably human and 0 = reads unmistakably like AI prose>, "reasons": [<1 to 3 short phrases, each under 8 words>]}`;

async function judgeText({ text, provider, model }) {
  if (isMock() || !provider) return null;
  const messages = [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: text.slice(0, 6000) },
  ];
  let r;
  try {
    r = await chatComplete({ provider, model, messages, temperature: 0.2, maxTokens: 220, responseFormat: { type: 'json_object' } });
  } catch (err) {
    // Some providers/models reject response_format - one retry without it
    if (err.fatal) r = await chatComplete({ provider, model, messages, temperature: 0.2, maxTokens: 220 });
    else throw err;
  }
  const m = r.content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Judge returned non-JSON output');
  const parsed = JSON.parse(m[0]);
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
  if (!Number.isFinite(score)) throw new Error('Judge returned no numeric score');
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 3).map(x => String(x).slice(0, 60)) : [];
  return { score, reasons, usage: r.usage };
}

module.exports = { rewriteChunk, judgeText, isMock, resolveProvider, listProviders };
