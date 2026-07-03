// Structure-aware chunking: split text into paragraph blocks, glue headings to the
// paragraph that follows them, aggregate blocks up to a target size, and pass fenced
// code blocks through untouched. Never splits inside a paragraph unless a single
// paragraph alone exceeds the hard max (then split on sentence boundaries).

const TARGET_CHARS = 2200;
const MAX_CHARS = 3400;

function isHeading(block) {
  if (/^#{1,6}\s/.test(block)) return true;
  // Short single line, no terminal punctuation -> likely a heading/title
  return !block.includes('\n') && block.length <= 70 && !/[.!?:;,]$/.test(block.trim());
}

function isCodeFence(block) {
  return /^\s*(```|~~~)/.test(block);
}

function splitLongParagraph(paragraph) {
  const sentences = paragraph.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [paragraph];
  const parts = [];
  let cur = '';
  for (const s of sentences) {
    if (cur.length + s.length > MAX_CHARS && cur) {
      parts.push(cur.trim());
      cur = '';
    }
    cur += s;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// Canonical paragraph split - the analyzer and selective humanizer MUST use
// the same split so paragraph indices always line up.
function splitParagraphs(text) {
  return text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
}

// Selective chunking: paragraphs whose index is in keepSet (plus anything that
// looks like code) pass through untouched; runs of flagged paragraphs are
// aggregated into rewritable chunks like normal.
function chunkSelective(text, keepSet) {
  const paras = splitParagraphs(text);
  const chunks = [];
  let cur = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length) {
      chunks.push({ text: cur.join('\n\n'), rewritable: true });
      cur = [];
      curLen = 0;
    }
  };
  paras.forEach((p, i) => {
    if (keepSet.has(i) || /```|~~~/.test(p)) {
      flush();
      chunks.push({ text: p, rewritable: false });
      return;
    }
    if (p.length > MAX_CHARS) {
      flush();
      for (const part of splitLongParagraph(p)) chunks.push({ text: part, rewritable: true });
      return;
    }
    if (curLen + p.length > TARGET_CHARS && cur.length) flush();
    cur.push(p);
    curLen += p.length + 2;
  });
  flush();
  return chunks.map((c, index) => ({ index, ...c }));
}

// Returns [{ index, text, rewritable }]
function chunkText(text) {
  const rawBlocks = splitParagraphs(text);

  // Re-join fenced code blocks that got split across blank lines
  const blocks = [];
  let codeBuf = null;
  for (const b of rawBlocks) {
    if (codeBuf !== null) {
      codeBuf.push(b);
      const fenceCount = codeBuf.join('\n\n').match(/```|~~~/g) || [];
      if (fenceCount.length % 2 === 0) {
        blocks.push({ text: codeBuf.join('\n\n'), code: true });
        codeBuf = null;
      }
      continue;
    }
    if (isCodeFence(b)) {
      const fences = b.match(/```|~~~/g) || [];
      if (fences.length % 2 === 1) { codeBuf = [b]; continue; }
      blocks.push({ text: b, code: true });
      continue;
    }
    blocks.push({ text: b, code: false });
  }
  if (codeBuf !== null) blocks.push({ text: codeBuf.join('\n\n'), code: true });

  const chunks = [];
  let cur = [];
  let curLen = 0;

  const flush = () => {
    if (cur.length) {
      chunks.push({ text: cur.join('\n\n'), rewritable: true });
      cur = [];
      curLen = 0;
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];

    if (b.code) {
      flush();
      chunks.push({ text: b.text, rewritable: false });
      continue;
    }

    if (b.text.length > MAX_CHARS) {
      flush();
      for (const part of splitLongParagraph(b.text)) {
        chunks.push({ text: part, rewritable: true });
      }
      continue;
    }

    // A heading starts a fresh chunk so it stays glued to what follows it
    if (isHeading(b.text) && curLen > TARGET_CHARS * 0.5) flush();

    if (curLen + b.text.length > TARGET_CHARS && cur.length) flush();

    cur.push(b.text);
    curLen += b.text.length + 2;
  }
  flush();

  return chunks.map((c, index) => ({ index, ...c }));
}

module.exports = { chunkText, chunkSelective, splitParagraphs, TARGET_CHARS, MAX_CHARS };
