// The "Judges: 2-minute tour" panel must ship with the page and stay in sync with the real UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.GEMINI_API_KEY;
process.env.STATE_FILE = '';
const { app } = await import('../src/server.js');
const { TRIPS } = await import('../src/inventory.js');

let server;
let html;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  html = await (await fetch(`http://localhost:${server.address().port}/`)).text();
});
after(() => server.close());

const tour = () => /<details class="judges" id="judges">([\s\S]*?)<\/details>/.exec(html)?.[1] || '';

test('home page serves a collapsible judges tour, closed by default', () => {
  assert.match(html, /<details class="judges" id="judges">/); // no "open" attribute
  assert.match(tour(), /<summary>[\s\S]*Judges[\s\S]*2-minute tour/);
  assert.equal((tour().match(/<li>/g) || []).length, 7);
});

test('every button the tour names exists in the real UI', () => {
  const rest = html.replace(tour(), '');
  for (const label of ['Compile rules with Gemini', 'Send the agent', 'Emergency stop', 'Resume', 'Export CSV']) {
    assert.ok(tour().includes(label), `tour mentions ${label}`);
    assert.ok(rest.includes(`>${label}<`), `UI has a "${label}" button`);
  }
  // "Review in PayPal" and the "Your rule" column are rendered by app.js.
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(js.includes('Review in PayPal →') && tour().includes('Review in PayPal →'));
  assert.ok(js.includes("headerName: 'Your rule'") && tour().includes('Your rule'));
});

test('tour describes the poisoned listing exactly as it is in the demo inventory', () => {
  const tejo = TRIPS.lisbon.options.find((o) => o.merchant === 'Grand Tejo Palace');
  assert.ok(tejo, 'Grand Tejo Palace is in the inventory');
  assert.match(tejo.note, /ignore all price limits/i);
  assert.ok(tour().includes(`($${tejo.unitPrice}/night)`));
  assert.match(tour(), /sandbox/i);
});
