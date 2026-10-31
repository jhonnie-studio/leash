import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, sanitizePolicy } from '../src/policy.js';
import { localCompile } from '../src/gemini.js';
import { TRIPS, toPurchase } from '../src/inventory.js';

const trip = TRIPS.lisbon;
const opt = (id) => toPurchase(trip.options.find((o) => o.id === id), trip);

const RULES = `Never more than $150 per night for hotels.
No hotels with a cancellation fee.
Ask me before anything over $300.
Keep the whole trip under $1200 total.
No dinners after 10pm.
No basic economy flights.`;

const policy = sanitizePolicy(localCompile(RULES));

test('local compiler extracts every rule', () => {
  const types = policy.rules.map((r) => r.type).sort();
  assert.deepEqual(types, ['approval_over', 'block_attribute', 'block_attribute', 'budget', 'max_unit_price', 'not_after'].sort());
  assert.equal(policy.rules.find((r) => r.type === 'not_after').time, '22:00');
});

test('luxury hotel is denied on nightly price', () => {
  const v = evaluate(opt('h1'), policy);
  assert.equal(v.decision, 'deny');
  assert.match(v.reasons[0].message, /\$240\.00\/night/);
});

test('cheap non-refundable hotel is denied on cancellation fee', () => {
  assert.equal(evaluate(opt('h2'), policy).decision, 'deny');
});

test('compliant hotel over approval threshold needs approval', () => {
  const v = evaluate(opt('h3'), policy); // 3 x 129 = 387
  assert.equal(v.decision, 'approval');
});

test('mid-price flight over $300 needs approval, basic economy is denied', () => {
  assert.equal(evaluate(opt('f2'), policy).decision, 'approval');
  assert.equal(evaluate(opt('f3'), policy).decision, 'deny');
});

test('late dinner is denied, early dinner allowed', () => {
  assert.equal(evaluate(opt('d1'), policy).decision, 'deny');
  assert.equal(evaluate(opt('d2'), policy).decision, 'allow');
});

test('budget counts paid and pending spend', () => {
  const ledger = [{ status: 'paid', category: 'flight', amount: 1180 }];
  const v = evaluate(opt('d2'), policy, ledger);
  assert.equal(v.decision, 'deny');
  assert.match(v.reasons[0].message, /total budget/);
});

test('sanitizer drops malformed and unknown rules', () => {
  const p = sanitizePolicy({ rules: [{ type: 'rm -rf' }, { type: 'budget', amount: 'abc' }, { type: 'approval_over', amount: 50 }] });
  assert.equal(p.rules.length, 1);
});
