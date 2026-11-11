// OpenRouter (primary) -> Gemini direct (second) -> local parser, with fetch stubbed (no network, fake keys).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENROUTER_API_KEY = 'or-test-key';
process.env.OPENROUTER_MODEL = 'google/model-a,google/model-lite';
process.env.GEMINI_API_KEY = 'gm-test-key';
process.env.GEMINI_MODEL = 'model-direct';
process.env.GEMINI_COOLDOWN_MS = '1';
process.env.GEMINI_QUOTA_COOLDOWN_MS = '40';
process.env.GEMINI_TIMEOUT_MS = '100';
process.env.GEMINI_TOTAL_BUDGET_MS = '400';
const { compileRules, rankOptions, geminiStatus } = await import('../src/gemini.js');

const ok = { rules: [{ id: 'r1', type: 'approval_over', source: 'Ask me before anything over $300', amount: 300 }] };
let calls, requests;
// Queue entries are HTTP statuses, 'hang', or { content } for a custom OpenRouter reply.
const respond = (queue) => {
  calls = [];
  requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const openrouter = url.startsWith('https://openrouter.ai/');
    calls.push(openrouter ? `or:${body.model}` : `gm:${url.match(/models\/([^:]+)/)[1]}`);
    requests.push({ url, headers: init.headers, body });
    const next = queue.shift() ?? 200;
    if (next === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    if (typeof next === 'object') return Response.json({ choices: [{ message: { content: next.content } }] });
    if (next !== 200) return new Response(`{"error":{"code":${next},"message":"nope"}}`, { status: next });
    const text = JSON.stringify(ok);
    return Response.json(openrouter ? { choices: [{ message: { content: text } }] } : { candidates: [{ content: { parts: [{ text }] } }] });
  };
};
beforeEach(() => new Promise((r) => setTimeout(r, 100))); // let any cooldown from the last test pass

test('OpenRouter is tried first and a Gemini answer through it still reports compiledBy gemini', async () => {
  respond([200]);
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.compiledBy, 'gemini');
  assert.equal(out.via, 'openrouter');
  assert.deepEqual(calls, ['or:google/model-a']);
  const [req] = requests;
  assert.equal(req.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(req.headers.Authorization, 'Bearer or-test-key');
  assert.equal(req.headers['HTTP-Referer'], 'https://leash-dk04.onrender.com');
  assert.equal(req.headers['X-Title'], 'Leash');
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  assert.equal(geminiStatus().state, 'live');
});

test('a 402/429 on OpenRouter skips its other models and goes straight to Gemini direct', async () => {
  respond([402, 200]);
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.via, 'gemini-api');
  assert.deepEqual(calls, ['or:google/model-a', 'gm:model-direct']);
  assert.deepEqual(geminiStatus(), { state: 'live', note: 'Gemini live (gemini-api)', via: 'gemini-api' });
});

test('when both providers hit quota, status says rate-limited and no calls are made during the cooldown', async () => {
  respond([429, 429]);
  assert.equal((await compileRules('Ask me before anything over $300.')).compiledBy, 'local');
  assert.deepEqual(calls, ['or:google/model-a', 'gm:model-direct']);
  assert.equal(geminiStatus().state, 'fallback-rate-limited');
  respond([]);
  assert.equal((await compileRules('Ask me before anything over $300.')).compiledBy, 'local');
  assert.deepEqual(calls, []);
});

test('hung models stay inside the total budget before the local parser takes over', async () => {
  respond(['hang', 'hang', 'hang']);
  const started = Date.now();
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.compiledBy, 'local');
  assert.ok(Date.now() - started < 600, `took ${Date.now() - started} ms`);
  assert.deepEqual(calls.slice(0, 2), ['or:google/model-a', 'or:google/model-lite']);
});

test('a 503 on the first OpenRouter model falls through to the lite model', async () => {
  respond([503, 200]);
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.via, 'openrouter');
  assert.deepEqual(calls, ['or:google/model-a', 'or:google/model-lite']);
});

test('a compile reply without a rules array falls back to the local parser instead of an empty policy', async () => {
  respond([{ content: '{"oops":true}' }]);
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.compiledBy, 'local');
  assert.equal(out.rules.length, 1);
});

test('a fenced JSON reply is parsed, and ranking goes through OpenRouter too', async () => {
  respond([{ content: '```json\n{"ranking":["b","a"],"why":{"b":"closer"}}\n```' }]);
  const out = await rankOptions('somewhere quiet', [
    { id: 'a', unitPrice: 100 },
    { id: 'b', unitPrice: 90 },
  ]);
  assert.deepEqual(out.ranking, ['b', 'a']);
  assert.deepEqual(calls, ['or:google/model-a']);
});
