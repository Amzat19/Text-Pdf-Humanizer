// DOCX round-trip rewriting: open the .docx (a zip), surgically replace the
// text of prose paragraphs inside word/document.xml, and repack. Everything
// else - styles, fonts, tables, images, headers/footers, page setup - is
// untouched, so the document comes back looking identical.
//
// What gets rewritten: body paragraphs of >= MIN_WORDS words.
// What is preserved verbatim (skipped on purpose):
//   - table contents (data, not prose - and layout-critical)
//   - headings/captions/short lines (< MIN_WORDS words)
//   - paragraphs containing hyperlinks or field codes (TOC, page numbers)
//   - text boxes / shapes, headers, footers, footnotes
//
// Known v1 limitation: intra-paragraph run formatting (a bolded phrase
// mid-sentence) is flattened to the paragraph's leading run format, because
// rewritten text no longer maps onto the original runs.

const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const MIN_WORDS = 15;

function wordCount(s) {
  return (s.match(/\S+/g) || []).length;
}

function hasAncestor(node, localNames) {
  let cur = node.parentNode;
  while (cur) {
    if (localNames.includes(cur.localName)) return true;
    cur = cur.parentNode;
  }
  return false;
}

function getDescendants(el, localName) {
  const out = [];
  const walk = n => {
    for (let i = 0; i < (n.childNodes ? n.childNodes.length : 0); i++) {
      const c = n.childNodes[i];
      if (c.nodeType === 1) {
        if (c.localName === localName) out.push(c);
        walk(c);
      }
    }
  };
  walk(el);
  return out;
}

function hasDescendant(el, localNames) {
  let found = false;
  const walk = n => {
    if (found) return;
    for (let i = 0; i < (n.childNodes ? n.childNodes.length : 0); i++) {
      const c = n.childNodes[i];
      if (c.nodeType === 1) {
        if (localNames.includes(c.localName)) { found = true; return; }
        walk(c);
      }
    }
  };
  walk(el);
  return found;
}

// Collect the rewritable paragraphs of a parsed document.xml.
// Returns [{ node, text, tNodes }]
function collectParagraphs(doc) {
  const paras = [];
  const all = doc.getElementsByTagName('w:p');
  for (let i = 0; i < all.length; i++) {
    const p = all.item(i);
    if (hasAncestor(p, ['tbl', 'txbxContent'])) continue;           // tables, text boxes
    if (hasDescendant(p, ['hyperlink', 'fldSimple', 'instrText'])) continue; // links, fields
    const tNodes = getDescendants(p, 't');
    if (!tNodes.length) continue;
    const text = tNodes.map(t => t.textContent || '').join('');
    if (wordCount(text) < MIN_WORDS) continue;                       // headings, captions
    paras.push({ node: p, text, tNodes });
  }
  return paras;
}

function setParagraphText(para, newText) {
  const first = para.tNodes[0];
  first.textContent = newText;
  first.setAttribute('xml:space', 'preserve');
  for (let i = 1; i < para.tNodes.length; i++) para.tNodes[i].textContent = '';
}

// rewriteFn(text, index) -> Promise<string|null>  (null = keep original)
// onProgress(done, total) is called after each paragraph settles.
async function rewriteDocx(buffer, rewriteFn, { concurrency = 3, onProgress = () => {} } = {}) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('Not a valid .docx (word/document.xml missing)');
  const xml = await entry.async('string');

  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const paras = collectParagraphs(doc);

  let done = 0;
  let rewritten = 0;
  let failed = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, paras.length || 1) }, async () => {
    while (next < paras.length) {
      const i = next++;
      try {
        const out = await rewriteFn(paras[i].text, i);
        if (out && out.trim() && out.trim() !== paras[i].text) {
          setParagraphText(paras[i], out.trim().replace(/\n+/g, ' '));
          rewritten++;
        }
      } catch (_) {
        failed++; // keep the original text for this paragraph
      }
      done++;
      onProgress(done, paras.length);
    }
  });
  await Promise.all(workers);

  const newXml = new XMLSerializer().serializeToString(doc);
  zip.file('word/document.xml', newXml);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return {
    buffer: out,
    stats: { candidates: paras.length, rewritten, failed },
  };
}

// Used by the pre-flight response so the UI can show "N paragraphs to rewrite".
async function countRewritable(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('Not a valid .docx (word/document.xml missing)');
  const doc = new DOMParser().parseFromString(await entry.async('string'), 'text/xml');
  return collectParagraphs(doc).length;
}

module.exports = { rewriteDocx, countRewritable, MIN_WORDS };
