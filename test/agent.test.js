// End-to-end flow in mock mode (no PayPal/Gemini credentials needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.GEMINI_API_KEY;
const { app, state } = await import('../src/server.js');

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

const RULES = `Never more than $150 per night for hotels.
No hotels with a cancellation fee.
Ask me before anything over $300.
Keep the whole trip under $1200 total.
No dinners after 10pm.
No basic economy flights.`;

test('agent refuses to run without a connected wallet', async () => {
  const res = await post('/api/agent/run', { request: 'go' });
  assert.equal(res.status, 409);
});

test('full run: compile rules, connect wallet, agent books within the leash', async () => {
  assert.equal((await post('/api/policy', { text: RULES })).status, 200);
  const { approveUrl } = await (await post('/api/wallet/connect')).json();
  const ret = await fetch(approveUrl.replace(/^http:\/\/localhost:\d+/, base), { redirect: 'manual' });
  assert.equal(ret.status, 302);
  assert.ok(state.wallet);

  const { steps } = await (await post('/api/agent/run', { request: 'Luxury Lisbon trip' })).json();
  const byMerchant = Object.fromEntries(steps.map((s) => [s.merchant, s.status]));
  assert.equal(byMerchant['Palácio Azul Hotel'], 'blocked');
  assert.equal(byMerchant['Casa do Rio'], 'blocked');
  assert.equal(byMerchant['Alfama Loft Suites'], 'pending_approval');
  assert.equal(byMerchant['Tasca do Bairro'], 'paid');

  // Nothing paid may exceed the hard budget.
  const paid = steps.filter((s) => s.status === 'paid').reduce((a, s) => a + s.amount, 0);
  assert.ok(paid <= 1200);
});

test('human approval round-trip captures the order', async () => {
  const pending = state.audit.find((r) => r.status === 'pending_approval');
  const res = await fetch(`${base}/approve/return?token=${pending.orderId}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(pending.status, 'paid');
});

test('declining an approval charges nothing', async () => {
  const pending = state.audit.find((r) => r.status === 'pending_approval');
  await fetch(`${base}/approve/cancel?token=${pending.orderId}`, { redirect: 'manual' });
  assert.equal(pending.status, 'declined');
});

test('last run endpoint returns the latest attempts in order', async () => {
  const { steps } = await (await fetch(`${base}/api/agent/last`)).json();
  assert.ok(steps.length > 0);
  assert.equal(steps[0].category, 'flight');
});

test('garbage rules are rejected cleanly', async () => {
  assert.equal((await post('/api/policy', { text: '   ' })).status, 400);
});
