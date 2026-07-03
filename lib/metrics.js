// Heuristic humanness indicators, computed locally with no AI involved.
// Transparent style signals (rhythm variance, cliche density, formulaic
// structure, repetition) rolled into 0-100 scores with human-readable reasons,
// per paragraph and for the whole document.
//
// Honest framing: these are directional WRITING-STYLE signals, not an AI
// detector. The optional LLM judge (lib/llm.js judgeText) adds a second,
// stronger opinion; no tool can truly prove authorship.

const { splitParagraphs } = require('./chunker');

const AI_TELLS = [
  /\bdelve(s|d)?\b/gi,
  /\btapestry\b/gi,
  /\bmoreover\b/gi,
  /\bfurthermore\b/gi,
  /^additionally\b/gim,
  /\bit'?s important to note\b/gi,
  /\bit is worth noting\b/gi,
  /\bin today's (fast-paced|digital|modern|ever-changing|competitive) \w+/gi,
  /\bin conclusion\b/gi,
  /\bleverage(s|d)?\b/gi,
  /\bseamless(ly)?\b/gi,
  /\brobust\b/gi,
  /\bholistic\b/gi,
  /\bempower(s|ed|ing)?\b/gi,
  /\bunlock(s|ed|ing)? the\b/gi,
  /\bgame-chang(ing|er)\b/gi,
  /\bcutting-edge\b/gi,
  /\bnot only\b[^.!?]{3,80}\bbut also\b/gi,
  /\bwhether you'?re\b[^.!?]{3,60}\bor\b/gi,
  /\belevate(s|d)?\b/gi,
  /\bsupercharge(s|d)?\b/gi,
  /\bdive into\b/gi,
  /\bthe landscape of\b/gi,
  /\bthe realm of\b/gi,
  /\bharness(es|ed|ing)? the\b/gi,
  /\bfoster(s|ed|ing)? (a|an|the)\b/gi,
  /\bstreamline(s|d)?\b/gi,
  /\ba plethora of\b/gi,
  /\ba myriad of\b/gi,
  /\bactionable insights\b/gi,
];

const HEDGES = [
  /\bimportantly,/gi,
  /\bnotably,/gi,
  /\bcrucially,/gi,
  /\bessentially,/gi,
  /\bultimately,/gi,
  /\barguably,/gi,
  /\bin essence\b/gi,
  /\bat its core\b/gi,
];

function sentences(text) {
  return (text.match(/[^.!?\n]+[.!?]+["')\]]*|[^.!?\n]+$/gm) || [])
    .map(s => s.trim())
    .filter(s => s.split(/\s+/).length >= 2);
}

function words(text) {
  return (text.match(/[A-Za-zÀ-ÿ0-9''-]+/g) || []).map(w => w.toLowerCase());
}

function countMatches(text, regexes) {
  let n = 0;
  for (const re of regexes) {
    const m = text.match(re);
    if (m) n += m.length;
  }
  return n;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---------- per-paragraph analysis ----------

function paragraphAnalysis(p) {
  const wordList = words(p);
  const wordCount = wordList.length;
  const sents = sentences(p);

  if (wordCount < 15 || /```|~~~/.test(p)) {
    return { words: wordCount, sentences: sents.length, score: null, verdict: 'short', reasons: [], signals: {} };
  }

  const reasons = [];
  let score = 70; // neutral prior

  // rhythm variance
  let burstiness = null;
  if (sents.length >= 3) {
    const lens = sents.map(s => s.split(/\s+/).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    burstiness = mean > 0 ? sd / mean : 0;
    if (burstiness >= 0.5) { score += 14; reasons.push('varied sentence rhythm'); }
    else if (burstiness < 0.22 && sents.length >= 4) { score -= 16; reasons.push('very uniform sentence lengths'); }
  }

  // AI cliches
  const tells = countMatches(p, AI_TELLS);
  if (tells) { score -= Math.min(36, tells * 9); reasons.push(tells + ' AI-tell phrase' + (tells > 1 ? 's' : '')); }

  // hedging
  const hedges = countMatches(p, HEDGES);
  if (hedges) { score -= Math.min(15, hedges * 5); reasons.push('hedging fillers'); }

  // sentence-start repetition
  if (sents.length >= 3) {
    const starts = sents.map(s => (s.split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z']/g, ''));
    const maxStart = Math.max(...[...new Set(starts)].map(w => starts.filter(x => x === w).length));
    if (maxStart >= 3) { score -= 10; reasons.push('repetitive sentence openers'); }
  }

  // tidy triads ("fast, reliable, and secure")
  const triads = (p.match(/\b\w+, \w+(?: \w+)?, and \w+/g) || []).length;
  if (triads >= 2) { score -= 8; reasons.push('formulaic triple lists'); }

  // human-positive: contractions
  const contractions = (p.match(/\b\w+'(s|t|re|ve|ll|d|m)\b/gi) || []).length;
  if (contractions >= 1) { score += 6; reasons.push('uses contractions'); }

  // human-positive: expressive punctuation variety
  const punct = ['(', ';', '?', '—', '"'].filter(ch => p.includes(ch)).length;
  if (punct >= 2) { score += 6; reasons.push('varied punctuation'); }

  // abstract-noun density (long-word ratio)
  const longRatio = wordList.filter(w => w.length > 7).length / wordCount;
  if (longRatio > 0.30) { score -= 8; reasons.push('dense abstract wording'); }

  return {
    words: wordCount,
    sentences: sents.length,
    score: clamp(Math.round(score), 5, 98),
    verdict: null, // filled by verdictFor after optional judge blend
    reasons,
    signals: { burstiness: burstiness === null ? null : Math.round(burstiness * 100) / 100, tells, contractions, longRatio: Math.round(longRatio * 100) / 100 },
  };
}

function verdictFor(score) {
  if (score === null) return 'short';
  if (score >= 65) return 'human';
  if (score >= 45) return 'mixed';
  return 'ai-ish';
}

// ---------- document analysis ----------

function analyzeDoc(text) {
  const paras = splitParagraphs(text);
  const paragraphs = paras.map((p, index) => {
    const a = paragraphAnalysis(p);
    return { index, text: p, ...a, verdict: verdictFor(a.score) };
  });

  const scored = paragraphs.filter(p => p.score !== null);
  const totalWords = scored.reduce((a, p) => a + p.words, 0) || 1;
  let docScore = scored.length
    ? scored.reduce((a, p) => a + p.score * p.words, 0) / totalWords
    : null;

  const reasons = [];
  if (docScore !== null && scored.length >= 4) {
    // suspiciously uniform paragraph sizes
    const lens = scored.map(p => p.words);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    if (mean > 0 && sd / mean < 0.3) { docScore -= 7; reasons.push('very uniform paragraph sizes'); }
  }

  // whole-doc trigram repetition
  const wordList = words(text);
  if (wordList.length > 60 && docScore !== null) {
    const trigrams = new Map();
    for (let i = 0; i < wordList.length - 2; i++) {
      const key = wordList.slice(i, i + 3).join(' ');
      trigrams.set(key, (trigrams.get(key) || 0) + 1);
    }
    let repeated = 0;
    for (const count of trigrams.values()) if (count > 1) repeated += count - 1;
    const pct = (repeated / Math.max(1, wordList.length - 2)) * 100;
    if (pct > 3) { docScore -= 8; reasons.push('repeated phrasings across the document'); }
  }

  const overall = docScore === null
    ? { score: null, verdict: 'short', reasons: [] }
    : { score: clamp(Math.round(docScore), 5, 98), verdict: verdictFor(clamp(Math.round(docScore), 5, 98)), reasons };

  // legacy fields the before/after metrics strip reads
  const sents = sentences(text);
  const lens = sents.map(s => s.split(/\s+/).length);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const sd = lens.length ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length) : 0;
  overall.wordCount = wordList.length;
  overall.sentenceCount = sents.length;
  overall.avgSentenceLen = Math.round(mean * 10) / 10;
  overall.burstiness = mean > 0 ? Math.round((sd / mean) * 100) / 100 : 0;
  overall.aiTellCount = countMatches(text, AI_TELLS);

  return { overall, paragraphs };
}

// Back-compat: the humanize before/after strip calls analyze(text) and reads
// {score, burstiness, aiTellCount, avgSentenceLen, wordCount}.
function analyze(text) {
  return analyzeDoc(text).overall;
}

module.exports = { analyze, analyzeDoc, verdictFor };
