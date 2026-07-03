# Humanizer

Local AI text humanizer. Paste text or drop a document (.docx / .pdf / .txt / .md), pick a tone and rewrite strength, and get the same content back reading like a sharp human wrote it. Everything runs on this machine — the only outbound call is the LLM API request itself.

## Quickstart

```
cd C:\Users\HP\ai-humanizer
copy .env.example .env
# edit .env and paste ONE free API key (see below)
npm install
npm start
```

Open http://localhost:3777

> **If you humanize and the text comes back unchanged, you're in MOCK mode** (the pill in the top-right says so). Mock mode means no API key is configured — it only simulates the pipeline. Add a key and restart to get real rewrites.

## Free engines (no credit card, personal account)

The app auto-detects whichever key you paste into `.env`:

| Provider | Signup | Free tier | Default model |
|---|---|---|---|
| **Groq** (recommended) | console.groq.com | ~1,000 req/day | `llama-3.3-70b-versatile` (open-weights) |
| **Google AI Studio** | aistudio.google.com | ~1,500 req/day | `gemini-2.5-flash` |
| **Cerebras** | cloud.cerebras.ai | ~1M tokens/day | `llama-3.3-70b` |
| Custom / local Ollama | — | — | any OpenAI-compatible endpoint via `LLM_BASE_URL` |
| OpenRouter | openrouter.ai | paid | optional, not required |

One document run = 1 request per ~2,200-char chunk, so even a 20-page doc fits comfortably inside every free tier. Free tiers throttle per minute (HTTP 429) — the app backs off and retries automatically.

## How it works

1. Text is extracted from your file (or taken from the paste box) and normalized.
2. It's chunked paragraph-by-paragraph (~2,200 chars per chunk, headings glued to their section, code blocks passed through untouched).
3. Each chunk is rewritten by the LLM with a goal-driven prompt: preserve every fact, name, number and quote exactly; vary sentence rhythm; kill AI-tells (delve, moreover, seamless, "in today's fast-paced world", …); match your chosen tone and strength.
4. Chunks stream back into the UI as they finish. You get a clean result view and a word-by-word compare view.
5. Heuristic naturalness indicators (rhythm variance, vocabulary variety, AI-tell count) are computed locally before/after. They're writing-quality signals, **not** an AI detector.

## Document Mode (.docx in → same .docx out)

Drop a **.docx** on the File tab and choose **"Humanize document — keep formatting"**. You get the same file back with:

- **Preserved**: all styles, fonts, sizes, colors, headings, page layout, margins, images, lists, headers/footers — and **tables are deliberately left untouched** (table content is data, not prose).
- **Skipped on purpose**: headings and captions (under 15 words), paragraphs containing hyperlinks or field codes (TOC, page numbers), text boxes.
- **Rewritten**: prose paragraphs, using the tone/strength/engine you set.

Known v1 limitation: a bold/italic phrase *inside* a rewritten paragraph loses its inline emphasis (the paragraph's own formatting is kept; the rewritten text lands in the leading run). Everything else survives byte-identical.

## PDFs — the honest answer

A PDF cannot be text-swapped in place and still look right: PDF stores *positioned glyphs*, not flowing paragraphs. New (longer/shorter) text can't reflow, and embedded fonts only contain the exact characters the original used. No tool genuinely does this — humanizer sites hand you back plain text.

The workflow that works (you have Word installed):
1. Open the PDF **in Word** (File → Open — Word converts it to an editable document).
2. Save as .docx, run it through **Document Mode** here.
3. Export from Word as PDF (File → Save a Copy → PDF).

Near-identical for text-based PDFs; design-heavy PDFs convert imperfectly (that's Word's conversion, not the humanizer). Scanned PDFs are images and would need OCR first.

## Check humanness (before you humanize)

Hit **Check humanness** instead of Humanize. You get:

- An overall 0–100 humanness estimate: instant local heuristics (rhythm variance, AI-cliché density, formulaic structure, repetition) blended with an **AI judge** — your selected engine reads each paragraph and scores how AI-ish it sounds, with reasons.
- A per-paragraph breakdown: green = reads human, amber = mixed, red = AI-ish. Headings/code are passed over.
- **Humanize flagged only** — rewrites just the flagged paragraphs and passes everything else through untouched, so already-natural writing never gets degraded by rewriting.

Honesty note: this is directional, not a detector. Detector products (GPTZero, StealthWriter, …) measure statistical fingerprints, disagree with each other constantly, and can't prove authorship — neither can this. Use the score to decide where rewriting adds value, not as a certificate.

## Controls

- **Tone**: Natural professional / Conversational / Punchy copy / Formal & precise / Casual & friendly
- **Strength**: Light polish (fix tells only) / Standard rewrite (sentence-level) / Deep re-voice (restructure)
- **Model**: dropdown lists your provider's models; "Custom…" accepts any model id your provider serves
- **Voice sample**: paste a few paragraphs of real writing and the engine mimics that voice without copying phrases

## Costs

$0 on the free tiers above. A typical 1,000-word document ≈ 1,500–2,500 tokens each way — roughly 2–4 requests, out of ~1,000+ you get per day for free.

## History

Every run is saved to `data/history/*.json` (local only). Open the History drawer to reload past runs. Delete files there to purge.

## Roadmap ideas

- Voice sample library (save named voices)
- Batch mode: drop a folder, humanize every file
- .docx export with formatting preserved
