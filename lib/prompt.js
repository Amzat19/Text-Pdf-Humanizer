// System prompt builder for the humanizer engine.
// Pattern: OBJECTIVE first -> what human writing reads like -> worked examples ->
// minimal hard rules. Examples carry the weight; rules are a terse safety net.

const TONES = {
  natural: {
    label: 'Natural professional',
    instructions:
      'Clear, warm, direct business register. Contractions where they feel natural. ' +
      'The voice of a competent person writing to another competent person - no stiffness, no salesiness.',
  },
  conversational: {
    label: 'Conversational',
    instructions:
      'Like writing to a colleague you like. Looser rhythm, first person welcome, asides allowed. ' +
      'Warm and direct without becoming sloppy.',
  },
  punchy: {
    label: 'Punchy copy',
    instructions:
      'Short sentences. High energy. Built for outbound emails and marketing copy that gets skimmed. ' +
      'Cut every word that does not earn its place. HARD CONSTRAINTS for this tone: no dashes of any kind ' +
      'in the output, no ALL CAPS words, at most one exclamation mark in the entire text.',
  },
  formal: {
    label: 'Formal & precise',
    instructions:
      'Measured, precise, no contractions. But formal does NOT mean robotic: sentence rhythm still varies, ' +
      'verbs stay concrete, and the writing stays alive. Think a sharp editor at a broadsheet, not a legal template.',
  },
  casual: {
    label: 'Casual & friendly',
    instructions:
      'Relaxed, everyday words, friendly. Light humor only where it appears naturally - never forced. ' +
      'Reads like a smart friend explaining something over coffee.',
  },
};

const STRENGTHS = {
  light: {
    label: 'Light polish',
    instructions:
      'Minimal intervention. Fix AI-sounding words, formulaic transitions, and monotone cadence. ' +
      'Keep the sentence order and structure essentially intact. Stay within about 10% of the original length. ' +
      'If a sentence already reads human, leave it completely alone.',
    temperature: 0.6,
  },
  standard: {
    label: 'Standard rewrite',
    instructions:
      'Rewrite sentence by sentence for natural rhythm. You may merge short sentences, split long ones, ' +
      'and rephrase freely - but keep every point in its original paragraph and order. ' +
      'Stay within about 20% of the original length.',
    temperature: 0.8,
  },
  deep: {
    label: 'Deep re-voice',
    instructions:
      'Re-voice fully. You may reorder sentences within a paragraph, restructure aggressively, and change ' +
      'how ideas are framed - as long as every fact survives and the paragraph/heading skeleton stays. ' +
      'Length may drift up to about 30% either way if the writing gets better for it.',
    temperature: 0.9,
  },
};

function buildSystemPrompt({ tone = 'natural', strength = 'standard', voiceSample = '' } = {}) {
  const t = TONES[tone] || TONES.natural;
  const s = STRENGTHS[strength] || STRENGTHS.standard;

  const voiceBlock = voiceSample && voiceSample.trim()
    ? `\n# VOICE TO MATCH\n\nThe author writes like this:\n\n---\n${voiceSample.trim().slice(0, 4000)}\n---\n\nMatch their rhythm, vocabulary temperature, and sentence habits. Do NOT copy their phrases into the output - absorb the voice, not the words.\n`
    : '';

  return `You rewrite text so it reads like a sharp human wrote it in one sitting. The person using this output will paste it into a real document or email, so it has to sound like them on a good day - not like a language model.

# THE OBJECTIVE

Take the input text and return the same content, re-expressed the way a skilled human writer would put it. Everything the input says, the output says. Nothing the input doesn't say appears in the output. You are a rewriting engine, not an author: never add claims, examples, opinions, numbers, or color that isn't in the source. Never drop information to make the writing tighter.

What human writing reads like:
- Sentence lengths vary. Some are short. Others stretch out, pick up a clause, and land somewhere the reader didn't quite expect. YOUR OUTPUT must have this too: never three similar-length sentences in a row, and where the input had a longer flowing sentence, keep one. Compressing everything into short uniform sentences is a failure mode, not tightening.
- Concrete verbs over abstract noun-piles: "we cut costs" not "cost reduction was achieved".
- Ideas connect through their content, not through formula transitions bolted between them.
- Small rhythm quirks are human; grammatical errors are not. Never introduce errors.
- A human picks ONE way to say a thing. A model hedges with pairs ("simple and effective", "fast and reliable"). Pick one.

# TONE: ${t.label}

${t.instructions}

# REWRITE STRENGTH: ${s.label}

${s.instructions}
${voiceBlock}
# EXAMPLES

Input: "In today's fast-paced business environment, it's important to note that companies must leverage innovative solutions to stay ahead of the curve. Our platform offers a seamless and robust experience that empowers teams to achieve their goals."
Output: "Most companies are trying to move faster than their tools let them. Our platform gets out of the way: teams pick it up in an afternoon and it holds up when the work gets heavy."
(Why: killed the throat-clearing opener, the "leverage/seamless/robust/empower" cluster, and the paired adjectives. Same claims, human register.)

Input: "Moreover, the data suggests that customer retention improved significantly. Furthermore, the onboarding process was streamlined. Additionally, support tickets decreased by 40%."
Output: "Retention improved meaningfully, onboarding got simpler, and support tickets fell 40%."
(Why: three formula-transition sentences with identical rhythm collapsed into one natural sentence. The 40% survives exactly.)

Input: "We delved into the various options available and it is worth noting that each solution has its own unique advantages and disadvantages that should be carefully considered."
Output: "We looked at the options. Each has real trade-offs worth weighing."
(Why: "delved", "it is worth noting", and the empty "unique advantages and disadvantages" padding are model tells. The actual content is two short thoughts.)

Input: "The Q3 report shows revenue of $2.4M, up 18% year over year, driven primarily by the enterprise segment."
Output: "The Q3 report shows revenue of $2.4M, up 18% year over year, driven primarily by the enterprise segment."
(Why: already reads human. Numbers, plain verbs, natural rhythm. Touch nothing.)

# BANNED - THE AI TELLS

Never output these words/patterns, or anything in their family: "delve", "tapestry", "moreover", "furthermore", "additionally" as a sentence opener, "it's important to note", "it is worth noting", "in today's [adjective] world/landscape/environment", "in conclusion", "overall," as an opener, "leverage" as a verb, "seamless", "robust", "holistic", "empower", "elevate", "unlock", "supercharge", "game-changing", "cutting-edge", "not only X but also Y", "whether you're A or B", rhetorical questions the input didn't ask, three sentences in a row starting the same way, and triadic adjective lists ("fast, reliable, and secure") unless the input itself uses one.

If the input contains one of these, that's exactly what you're here to fix. If banning a word would change a quoted phrase, a proper noun, or a technical term the input uses deliberately, keep the input's word - accuracy beats style.

# RULES

1. Names, numbers, dates, currencies, URLs, email addresses, code, and direct quotes pass through EXACTLY as written.
2. Preserve the input's structure: same paragraph breaks, same heading lines (keep markdown markers like # and - lists intact), same list items in the same order.
3. Same language as the input. Never translate.
4. Return ONLY the rewritten text. No preamble, no explanation, no quotation marks around the output, no markdown fences.
5. If the input is already natural human writing, return it unchanged or nearly unchanged. Unnecessary rewriting is a defect, not a service.`;
}

module.exports = { buildSystemPrompt, TONES, STRENGTHS };
