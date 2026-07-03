// Document text extraction: .docx, .pdf, .txt, .md -> plain text / light markdown
//
// mammoth and pdf-parse are required LAZILY inside the branches that need them.
// This keeps these heavy libraries off the cold-start path of the text-only
// endpoints (config/analyze/rewrite/judge) - so a hosted function serving those
// never even loads them.
const path = require('path');

function normalize(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// mammoth's markdown writer escapes punctuation (fast\-paced, $2\.4M) - undo it
// so literal backslashes never reach the rewrite engine.
function unescapeMarkdown(text) {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
}

async function extractText(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();

  if (ext === '.docx') {
    const mammoth = require('mammoth');
    // Markdown conversion keeps headings and lists so the rewrite preserves structure.
    try {
      const md = await mammoth.convertToMarkdown({ buffer });
      if (md.value && md.value.trim()) return normalize(unescapeMarkdown(md.value));
    } catch (_) { /* fall through to raw text */ }
    const raw = await mammoth.extractRawText({ buffer });
    return normalize(raw.value || '');
  }

  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const result = await pdfParse(buffer);
    return normalize(result.text || '');
  }

  if (ext === '.txt' || ext === '.md' || ext === '.markdown' || ext === '') {
    return normalize(buffer.toString('utf8'));
  }

  throw new Error(`Unsupported file type "${ext}" - supported: .docx, .pdf, .txt, .md`);
}

module.exports = { extractText };
