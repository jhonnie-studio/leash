import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { evaluate, sanitizePolicy } from './policy.js';
import { compileRules, rankOptions, geminiEnabled } from './gemini.js';
import { TRIPS, toPurchase } from './inventory.js';
import * as paypal from './paypal.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CATEGORY_ORDER = ['flight', 'hotel', 'dinner', 'activity'];

// One private demo session per browser (cookie), so judges trying the live
// site at the same time never see each other's rules, wallet or audit log.
const SESSION_COOKIE = 'leash_sid';
const MAX_SESSIONS = 500;
const MAX_AUDIT_ROWS = 500;
const sessions = new Map(); // sid -> session

function newSession() {
  return {
    policy: { currency: 'USD', rules: [] },
    rulesText: '',
    // Optional shared demo wallet: a sandbox vault payment token set on the host,
    // so judges can watch the full flow without their own PayPal sandbox login.
    wallet: process.env.DEMO_PAYMENT_TOKEN_ID ? { paymentTokenId: process.env.DEMO_PAYMENT_TOKEN_ID, preloaded: true } : null,
    pendingSetup: null,
    audit: [],
    // Emergency stop: when on, every payment is refused before any rule runs.
    halted: false,
    haltedAt: null,
    lastSeen: Date.now(),
  };
}

const ESTOP_SOURCE = 'Emergency stop';
const ESTOP_REASON = { ruleId: 'estop', source: ESTOP_SOURCE, message: 'Emergency stop is on: the owner halted all payments' };
const blockedSinceStop = (s) =>
  s.halted ? s.audit.filter((r) => r.reasons?.[0]?.ruleId === 'estop' && r.status === 'blocked' && r.time >= s.haltedAt).length : 0;

// Persist sessions to disk so a restart or redeploy doesn't drop them.
// Set STATE_FILE="" to disable (tests do).
const STATE_FILE = process.env.STATE_FILE ?? new URL('../data/state.json', import.meta.url).pathname;
if (STATE_FILE && existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    for (const [sid, s] of saved.sessions || []) sessions.set(sid, { ...newSession(), ...s });
  } catch (err) {
    console.warn('[state] could not load saved state:', err.message);
  }
}
function save() {
  if (!STATE_FILE) return;
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ sessions: [...sessions] }));
}

function readSid(req) {
  const m = /(?:^|;\s*)leash_sid=([0-9a-f-]{36})(?:;|$)/.exec(req.headers.cookie || '');
  return m && sessions.has(m[1]) ? m[1] : null;
}

function sessionMiddleware(req, res, next) {
  let sid = readSid(req);
  if (!sid) {
    if (sessions.size >= MAX_SESSIONS) {
      // Drop the least recently used session.
      let oldest = null;
      for (const [k, s] of sessions) if (!oldest || s.lastSeen < sessions.get(oldest).lastSeen) oldest = k;
      sessions.delete(oldest);
    }
    sid = randomUUID();
    sessions.set(sid, newSession());
    const secure = PUBLIC_URL.startsWith('https://') ? '; Secure' : '';
    res.append('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
  }
  req.session = sessions.get(sid);
  req.session.lastSeen = Date.now();
  next();
}

// PayPal redirects back here after approval; find the row in whichever session owns it.
function findPending(orderId) {
  for (const s of sessions.values()) {
    const row = s.audit.find((r) => r.orderId === orderId && r.status === 'pending_approval');
    if (row) return { row, session: s };
  }
  return {};
}

const app = express();
app.use(express.json({ limit: '50kb' }));
// Save after every request that can change state.
app.use((req, res, next) => {
  if (req.method === 'POST' || /^\/(wallet|approve)\//.test(req.path)) res.on('finish', save);
  next();
});
app.use(express.static(new URL('../public', import.meta.url).pathname));
app.use(['/api', '/wallet', '/approve'], sessionMiddleware);

const log = (state, entry) => {
  const row = { id: randomUUID(), time: new Date().toISOString(), ...entry };
  state.audit.unshift(row);
  state.audit.length = Math.min(state.audit.length, MAX_AUDIT_ROWS);
  return row;
};

app.get('/api/status', (req, res) => {
  const state = req.session;
  res.json({
    gemini: geminiEnabled ? 'live' : 'offline-fallback',
    paypal: paypal.paypalEnabled ? 'sandbox' : 'mock',
    walletConnected: Boolean(state.wallet),
    walletPreloaded: Boolean(state.wallet?.preloaded),
    privateSession: true,
    halted: Boolean(state.halted),
    haltedAt: state.haltedAt,
    blockedSinceStop: blockedSinceStop(state),
    policy: state.policy,
    rulesText: state.rulesText,
    trips: Object.fromEntries(Object.entries(TRIPS).map(([k, t]) => [k, { title: t.title, options: t.options }])),
  });
});

app.post('/api/policy', async (req, res) => {
  const state = req.session;
  const text = String(req.body?.text || '').slice(0, 2000);
  if (!text.trim()) return res.status(400).json({ error: 'Write at least one rule.' });
  try {
    const raw = await compileRules(text);
    const compiled = sanitizePolicy(raw);
    state.policy = compiled;
    state.rulesText = text;
    res.json({ ...compiled, compiledBy: raw.compiledBy });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not compile rules. Try rephrasing.' });
  }
});

// --- wallet (one-time human authorisation) ----------------------------------

app.post('/api/wallet/connect', async (req, res) => {
  const state = req.session;
  try {
    const setup = await paypal.createWalletSetup(`${PUBLIC_URL}/wallet/return`, `${PUBLIC_URL}/?wallet=cancelled`);
    state.pendingSetup = setup.setupTokenId;
    res.json({ approveUrl: setup.approveUrl });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/wallet/return', async (req, res) => {
  const state = req.session;
  try {
    if (!state.pendingSetup) throw new Error('No wallet setup in progress');
    state.wallet = await paypal.finishWalletSetup(state.pendingSetup);
    state.pendingSetup = null;
    res.redirect('/?wallet=connected');
  } catch (err) {
    console.error(err);
    res.redirect('/?wallet=error');
  }
});

// --- emergency stop ----------------------------------------------------------

app.post('/api/estop', (req, res) => {
  const state = req.session;
  const on = req.body?.on === true;
  if (on !== state.halted) {
    state.halted = on;
    state.haltedAt = on ? new Date().toISOString() : null;
    log(state, {
      category: 'system', merchant: on ? 'Owner pressed emergency stop' : 'Owner resumed', amount: 0,
      decision: on ? 'deny' : 'allow', status: on ? 'estop_on' : 'estop_off',
      reasons: [{ ruleId: 'estop', source: ESTOP_SOURCE, message: on ? 'All agent payments halted' : 'Agent payments resumed under your rules' }],
    });
  }
  res.json({ halted: state.halted, haltedAt: state.haltedAt, blockedSinceStop: blockedSinceStop(state) });
});

// --- the agent ---------------------------------------------------------------

app.post('/api/agent/run', async (req, res) => {
  const state = req.session;
  const tripKey = String(req.body?.trip || 'lisbon');
  const trip = Object.hasOwn(TRIPS, tripKey) ? TRIPS[tripKey] : null;
  const request = String(req.body?.request || '').slice(0, 1000) || 'Book my trip.';
  if (!trip) return res.status(404).json({ error: 'Unknown trip' });
  if (!state.wallet) return res.status(409).json({ error: 'Connect the PayPal wallet first.' });
  // Fail closed: an agent with no compiled rules would be allowed to buy anything.
  if (!state.policy.rules.length) return res.status(409).json({ error: 'Compile your rules first — no leash, no payments.' });

  const runId = randomUUID().slice(0, 8);
  const steps = [];

  for (const category of CATEGORY_ORDER) {
    const options = trip.options.filter((o) => o.category === category);
    if (!options.length) continue;
    // Emergency stop: refuse the attempt before any rule or PayPal call, and log it.
    if (state.halted) {
      const purchase = toPurchase(options[0], trip);
      steps.push(log(state, { runId, category, merchant: purchase.merchant, amount: purchase.amount, decision: 'deny', status: 'blocked', reasons: [ESTOP_REASON] }));
      continue;
    }
    const { ranking, why } = await rankOptions(request, options);
    let settled = false;

    for (const id of ranking) {
      const option = options.find((o) => o.id === id);
      const purchase = toPurchase(option, trip);
      // Each run is one trip: budgets only count this run's spend.
      const verdict = evaluate(purchase, state.policy, state.audit.filter((r) => r.runId === runId));
      const base = { runId, category, merchant: purchase.merchant, amount: purchase.amount, decision: verdict.decision, reasons: verdict.reasons, agentWhy: why[id] || option.note };

      if (verdict.decision === 'deny') {
        steps.push(log(state, { ...base, status: 'blocked' }));
        continue;
      }
      try {
        if (verdict.decision === 'approval') {
          const order = await paypal.createApprovalOrder(purchase, `${PUBLIC_URL}/approve/return`, `${PUBLIC_URL}/approve/cancel`, `${runId}-${id}`);
          steps.push(log(state, { ...base, status: 'pending_approval', orderId: order.orderId, approveUrl: order.approveUrl }));
        } else {
          const charge = await paypal.chargeVaulted(purchase, state.wallet.paymentTokenId, `${runId}-${id}`);
          steps.push(log(state, { ...base, status: charge.status === 'COMPLETED' ? 'paid' : 'failed', orderId: charge.orderId, captureId: charge.captureId }));
        }
      } catch (err) {
        console.error(err);
        steps.push(log(state, { ...base, status: 'failed', reasons: [{ message: err.message }] }));
      }
      settled = true;
      break;
    }

    if (!settled) steps.push(log(state, { runId, category, merchant: '—', amount: 0, decision: 'deny', status: 'no_option', reasons: [{ message: `No ${category} option fits your rules, so the agent booked nothing.` }] }));
  }

  res.json({ runId, steps });
});

// --- human approval round-trip ----------------------------------------------

app.get('/approve/return', async (req, res) => {
  const { row, session } = findPending(req.query.token);
  if (!row) return res.redirect('/?approval=unknown');
  // While the emergency stop is on, even an approved order is not captured.
  if (session.halted) {
    log(session, { runId: row.runId, category: row.category, merchant: row.merchant, amount: row.amount, decision: 'deny', status: 'blocked', orderId: row.orderId, reasons: [ESTOP_REASON] });
    return res.redirect('/?approval=halted');
  }
  try {
    const cap = await paypal.captureApprovedOrder(row.orderId);
    Object.assign(row, { status: cap.status === 'COMPLETED' ? 'paid' : 'failed', captureId: cap.captureId, approvedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    row.status = 'failed';
  }
  res.redirect('/?approval=done');
});

app.get('/approve/cancel', (req, res) => {
  const { row } = findPending(req.query.token);
  if (row) row.status = 'declined';
  res.redirect('/?approval=declined');
});

app.get('/api/audit', (req, res) => res.json(req.session.audit));

app.post('/api/reset', (req, res) => {
  req.session.audit = [];
  res.json({ ok: true });
});

// Latest run, so a page reload still shows what the agent just did.
app.get('/api/agent/last', (req, res) => {
  const state = req.session;
  const runId = state.audit.find((r) => r.runId)?.runId;
  res.json({ runId, steps: runId ? state.audit.filter((r) => r.runId === runId).reverse() : [] });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

export { app, sessions };

// Start listening only when run directly (tests import the app instead).
if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(PORT, () => {
    console.log(`Leash on ${PUBLIC_URL} — Gemini: ${geminiEnabled ? 'live' : 'offline fallback'}, PayPal: ${paypal.paypalEnabled ? 'sandbox' : 'mock'}`);
  });
}
