// End-to-end flow in mock mode (no PayPal/Gemini credentials needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.GEMINI_API_KEY;
process.env.STATE_FILE = '';
const { app, sessions } = await import('../src/server.js');

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

// A tiny cookie jar so every request belongs to one browser session.
let cookie = '';
const send = async (path, opts = {}) => {
  const res = await fetch(base + path, { ...opts, headers: { ...opts.headers, cookie } });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
};
const get = (path) => send(path, { redirect: 'manual' });
const post = (path, body) => send(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const mine = () => sessions.get(cookie.split('=')[1]);

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

test('agent refuses to pay with no compiled rules (fails closed)', async () => {
  mine().wallet = { paymentTokenId: 'MOCK-VAULT-TEST' };
  const res = await post('/api/agent/run', { request: 'go' });
  assert.equal(res.status, 409);
  assert.equal(mine().audit.length, 0);
  mine().wallet = null;
});

test('full run: compile rules, connect wallet, agent books within the leash', async () => {
  assert.equal((await post('/api/policy', { text: RULES })).status, 200);
  const { approveUrl } = await (await post('/api/wallet/connect')).json();
  const ret = await get(approveUrl.replace(/^http:\/\/localhost:\d+/, ''));
  assert.equal(ret.status, 302);
  assert.ok(mine().wallet);

  const { steps } = await (await post('/api/agent/run', { request: 'Luxury Lisbon trip' })).json();
  const byMerchant = Object.fromEntries(steps.map((s) => [s.merchant, s.status]));
  // A listing that tells the agent to ignore its limits is still blocked by code.
  assert.equal(byMerchant['Grand Tejo Palace'], 'blocked');
  assert.equal(byMerchant['Palácio Azul Hotel'], 'blocked');
  assert.equal(byMerchant['Casa do Rio'], 'blocked');
  assert.equal(byMerchant['Alfama Loft Suites'], 'pending_approval');
  assert.equal(byMerchant['Tasca do Bairro'], 'paid');

  // Nothing paid may exceed the hard budget.
  const paid = steps.filter((s) => s.status === 'paid').reduce((a, s) => a + s.amount, 0);
  assert.ok(paid <= 1200);
});

test('a second trip gets its own budget', async () => {
  const { steps } = await (await post('/api/agent/run', { request: 'Same trip again' })).json();
  assert.equal(steps.find((s) => s.merchant === 'Tasca do Bairro')?.status, 'paid');
  assert.ok(!steps.some((s) => /total budget/.test(s.reasons?.[0]?.message || '') && s.category === 'flight'));
});

test('human approval round-trip captures the order', async () => {
  const pending = mine().audit.find((r) => r.status === 'pending_approval');
  // PayPal's redirect may arrive without our cookie; the order id alone finds the row.
  const res = await fetch(`${base}/approve/return?token=${pending.orderId}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(pending.status, 'paid');
});

test('declining an approval charges nothing', async () => {
  const pending = mine().audit.find((r) => r.status === 'pending_approval');
  await get(`/approve/cancel?token=${pending.orderId}`);
  assert.equal(pending.status, 'declined');
});

test('last run endpoint returns the latest attempts in order', async () => {
  const { steps } = await (await get('/api/agent/last')).json();
  assert.ok(steps.length > 0);
  assert.equal(steps[0].category, 'flight');
});

test('another browser gets its own private session', async () => {
  const other = await (await fetch(`${base}/api/status`)).json();
  assert.equal(other.rulesText, '');
  assert.equal(other.walletConnected, false);
  assert.equal((await (await fetch(`${base}/api/audit`)).json()).length, 0);
  const own = await (await get('/api/status')).json();
  assert.ok(own.rulesText.includes('$150'));
  assert.ok((await (await get('/api/audit')).json()).length > 0);
});

test('garbage rules are rejected cleanly', async () => {
  assert.equal((await post('/api/policy', { text: '   ' })).status, 400);
});
