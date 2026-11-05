// Gemini retry behaviour, with fetch stubbed out (no network, fake key).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODEL = 'model-a,model-b';
process.env.GEMINI_RETRY_DELAY_MS = '0';
process.env.GEMINI_COOLDOWN_MS = '1';
const { compileRules } = await import('../src/gemini.js');

const ok = { rules: [{ id: 'r1', type: 'approval_over', source: 'Ask me before anything over $300', amount: 300 }] };
let calls;
const respond = (queue) => {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url.match(/models\/([^:]+)/)[1]);
    const status = queue.shift() ?? 200;
    const body = status === 200 ? JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ok) }] } }] }) : '{"error":"overloaded"}';
    return new Response(body, { status });
  };
};
beforeEach(() => new Promise((r) => setTimeout(r, 5))); // let the 1 ms cooldown pass

test('a single 503 is retried on the same model and still compiles with Gemini', async () => {
  respond([503]);
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.compiledBy, 'gemini');
  assert.deepEqual(calls, ['model-a', 'model-a']);
});

test('a model that stays busy falls through to the next one', async () => {
  respond([503, 503]);
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.compiledBy, 'gemini');
  assert.deepEqual(calls, ['model-a', 'model-a', 'model-b']);
});

test('a 400 is not retried, and when every model fails the local parser takes over', async () => {
  respond([400, 503, 503]);
  const out = await compileRules('Ask me before anything over $300.');
  assert.equal(out.compiledBy, 'local');
  assert.deepEqual(calls, ['model-a', 'model-b', 'model-b']);
});
