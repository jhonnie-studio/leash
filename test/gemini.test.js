// Gemini fail-fast behaviour, with fetch stubbed out (no network, fake key).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODEL = 'model-a,model-b';
process.env.GEMINI_COOLDOWN_MS = '1';
process.env.GEMINI_QUOTA_COOLDOWN_MS = '40';
process.env.GEMINI_TIMEOUT_MS = '100';
process.env.GEMINI_TOTAL_BUDGET_MS = '400';
const { compileRules, geminiStatus } = await import('../src/gemini.js');

const ok = { rules: [{ id: 'r1', type: 'approval_over', source: 'Ask me before anything over $300', amount: 300 }] };
let calls, bodies;
// Queue entries: an HTTP status, or 'hang' for a request that never answers (until aborted).
const respond = (queue) => {
  calls = [];
  bodies = [];
  globalThis.fetch = async (url, init) => {
    calls.push(url.match(/models\/([^:]+)/)[1]);
    bodies.push(JSON.parse(init.body));
    const status = queue.shift() ?? 200;
    if (status === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    const body =
      status === 200
        ? JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ok) }] } }] })
        : status === 429
          ? '{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED"}}'
          : '{"error":"overloaded"}';
    return new Response(body, { status });
  };
};
beforeEach(() => new Promise((r) => setTimeout(r, 60))); // let any cooldown from the last test pass

test('a 503 is not retried on the same model: the next model answers', async () => {
  respond([503]);
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.compiledBy, 'gemini');
  assert.deepEqual(calls, ['model-a', 'model-b']);
  assert.equal(geminiStatus().state, 'live');
});

test('a 429 quota error falls back at once, cools down, and status stops saying live', async () => {
  respond([429]);
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.compiledBy, 'local');
  assert.deepEqual(calls, ['model-a']);
  assert.equal(geminiStatus().state, 'fallback-rate-limited');
  respond([]);
  assert.equal((await compileRules('Ask me before anything over $300.')).compiledBy, 'local');
  assert.deepEqual(calls, [], 'no Gemini call during the cooldown');
});

test('hung models time out inside the total budget and the local parser takes over', async () => {
  respond(['hang', 'hang']);
  const started = Date.now();
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.compiledBy, 'local');
  assert.deepEqual(calls, ['model-a', 'model-b']);
  assert.ok(Date.now() - started < 400, `took ${Date.now() - started} ms`);
});

test('when every model errors, the local parser takes over', async () => {
  respond([400, 503]);
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.compiledBy, 'local');
  assert.deepEqual(calls, ['model-a', 'model-b']);
});

test('every Gemini request opts out of request logging (store: false)', async () => {
  respond([]);
  await compileRules('Ask me before anything over $300.');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].store, false);
});
