// Gemini is used for two things: compiling natural-language rules into the
// policy schema, and ranking travel options against the user's request.
// Without GEMINI_API_KEY the module falls back to a small local parser so the
// demo runs end to end offline.

import { RULE_TYPES } from './policy.js';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export const geminiEnabled = Boolean(API_KEY);

async function generateJson(prompt) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(text);
}

const COMPILE_PROMPT = (rulesText) => `You convert a traveller's spending rules for their AI booking agent into JSON.
Return {"rules":[...]} where each rule has: "id" (r1, r2...), "type", "source" (the exact phrase it came from), plus fields:
- max_unit_price: category, amount, unit ("night" for hotels, "seat" for flights, "item" otherwise)
- budget: category ("*" for overall), amount
- approval_over: amount
- block_attribute: attribute (one of: cancellation_fee, basic_economy, overnight_layover)
- merchant_block / merchant_allow: merchants (array of names)
- min_rating: category, value (0-5)
- not_after: category, time ("HH:MM", 24h)
Allowed types: ${RULE_TYPES.join(', ')}. Categories: hotel, flight, dinner, activity, "*".
All amounts are USD numbers. Ignore anything that is not a spending rule. Do not invent rules.

Rules:
"""${rulesText}"""`;

/** Returns { rules, compiledBy }. Falls back to the local parser if Gemini is unavailable. */
export async function compileRules(rulesText) {
  if (geminiEnabled) {
    try {
      return { ...(await generateJson(COMPILE_PROMPT(rulesText))), compiledBy: 'gemini' };
    } catch (err) {
      console.warn('[gemini] compile failed, using local parser:', err.message);
    }
  }
  return { ...localCompile(rulesText), compiledBy: 'local' };
}

const RANK_PROMPT = (request, options) => `You are a travel booking agent. The traveller asked:
"""${request}"""
Rank these options from what the traveller would like most to least, ignoring price limits (a separate policy engine enforces those).
Return {"ranking":[ids...],"why":{"<id>":"one short sentence"}}.
Options: ${JSON.stringify(options)}`;

export async function rankOptions(request, options) {
  if (geminiEnabled) {
    try {
      const out = await generateJson(RANK_PROMPT(request, options));
      const known = new Set(options.map((o) => o.id));
      const ranking = (out.ranking || []).filter((id) => known.has(id));
      for (const o of options) if (!ranking.includes(o.id)) ranking.push(o.id);
      return { ranking, why: out.why || {} };
    } catch (err) {
      console.warn('[gemini] ranking failed, using local ranking:', err.message);
    }
  }
  // Local stand-in: an eager agent that reaches for the best-rated, priciest option first.
  const ranking = [...options]
    .sort((a, b) => (b.attributes?.rating ?? 0) - (a.attributes?.rating ?? 0) || b.unitPrice - a.unitPrice)
    .map((o) => o.id);
  return { ranking, why: {} };
}

// --- offline fallback --------------------------------------------------------

const CATEGORY_WORDS = {
  hotel: /hotel|night|room|stay/i,
  flight: /flight|fly|seat|airline/i,
  dinner: /dinner|restaurant|food|meal/i,
  activity: /activit|tour|ticket/i,
};

function guessCategory(line) {
  for (const [cat, re] of Object.entries(CATEGORY_WORDS)) if (re.test(line)) return cat;
  return '*';
}

export function localCompile(text) {
  const rules = [];
  const add = (rule) => rules.push({ id: `r${rules.length + 1}`, ...rule });
  for (const raw of text.split(/\n|;|\.(?=\s|$)/)) {
    const line = raw.trim();
    if (!line) continue;
    const amount = Number((line.match(/\$\s?(\d+(?:\.\d+)?)/) || [])[1]);
    const category = guessCategory(line);
    if (/approv|ask me|check with me/i.test(line) && amount) add({ type: 'approval_over', amount, source: line });
    else if (/per night|\/night|a night|per seat|each/i.test(line) && amount)
      add({ type: 'max_unit_price', category, amount, unit: category === 'hotel' ? 'night' : category === 'flight' ? 'seat' : 'item', source: line });
    else if (/total|budget|in all|overall|whole trip/i.test(line) && amount) add({ type: 'budget', category, amount, source: line });
    else if (/cancell?ation fee|non-?refundable/i.test(line)) add({ type: 'block_attribute', attribute: 'cancellation_fee', source: line });
    else if (/basic economy/i.test(line)) add({ type: 'block_attribute', attribute: 'basic_economy', source: line });
    else if (/overnight layover|red-?eye/i.test(line)) add({ type: 'block_attribute', attribute: 'overnight_layover', source: line });
    else if (/rated|stars?|rating/i.test(line)) {
      const value = Number((line.match(/(\d(?:\.\d)?)\s*(?:\+|stars?|or)/) || [])[1]);
      if (value) add({ type: 'min_rating', category, value, source: line });
    } else if (/after\s+(\d{1,2})(?::(\d{2}))?\s*(pm|am)?/i.test(line)) {
      const [, h, m = '00', ap] = line.match(/after\s+(\d{1,2})(?::(\d{2}))?\s*(pm|am)?/i);
      const hour = (Number(h) % 12) + (ap?.toLowerCase() === 'pm' || (!ap && Number(h) < 12 && Number(h) > 6) ? 12 : 0);
      add({ type: 'not_after', category, time: `${String(hour).padStart(2, '0')}:${m}`, source: line });
    } else if (/never|don't|do not|no\b/i.test(line) && /from|at|with/i.test(line)) {
      const merchant = (line.match(/(?:from|at|with)\s+([A-Z][\w&' -]+)/) || [])[1];
      if (merchant) add({ type: 'merchant_block', merchants: [merchant.trim()], source: line });
    } else if (amount && /max|under|no more than|limit|cap/i.test(line)) {
      add({ type: 'max_unit_price', category, amount, unit: 'item', source: line });
    }
  }
  return { rules };
}
