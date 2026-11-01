const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const ICONS = { flight: '✈️', hotel: '🏨', dinner: '🍽️', activity: '🎟️' };
const STATUS_LABEL = {
  paid: 'Paid', pending_approval: 'Needs your OK', blocked: 'Blocked', no_option: 'Nothing fits',
  declined: 'You declined', failed: 'Failed',
};
const DECISION_CLASS = { paid: 'allow', pending_approval: 'approval' };

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

// --- status ------------------------------------------------------------------

async function refreshStatus() {
  const s = await api('/api/status');
  $('pills').innerHTML = `
    <span class="pill ${s.gemini === 'live' ? 'on' : ''}">Gemini <b>${s.gemini === 'live' ? 'live' : 'offline'}</b></span>
    <span class="pill ${s.paypal === 'sandbox' ? 'on' : ''}">PayPal <b>${s.paypal}</b></span>
    <span class="pill ${s.walletConnected ? 'on' : ''}">Wallet <b>${s.walletConnected ? 'connected' : 'not connected'}</b></span>`;
  const ws = $('walletState');
  ws.textContent = s.walletPreloaded
    ? '✓ Shared sandbox demo wallet connected (vaulted PayPal token)'
    : s.walletConnected ? '✓ Agent wallet connected (vaulted PayPal token)' : 'Not connected';
  ws.classList.toggle('ok', s.walletConnected);
  $('connect').textContent = s.walletConnected ? 'Reconnect' : 'Connect PayPal wallet';
  if (s.rulesText) $('rules').value = s.rulesText;
  renderRules(s.policy);
}

// --- rules -------------------------------------------------------------------

function describe(rule) {
  switch (rule.type) {
    case 'max_unit_price': return `${rule.category} ≤ ${money(rule.amount)}/${rule.unit || 'item'}`;
    case 'budget': return `${rule.category === '*' || !rule.category ? 'trip' : rule.category} ≤ ${money(rule.amount)}`;
    case 'approval_over': return `ask above ${money(rule.amount)}`;
    case 'block_attribute': return `no ${rule.attribute.replace(/_/g, ' ')}`;
    case 'merchant_block': return `block ${rule.merchants.join(', ')}`;
    case 'merchant_allow': return `only ${rule.merchants.join(', ')}`;
    case 'min_rating': return `${rule.category} ≥ ${rule.value}★`;
    case 'not_after': return `${rule.category} before ${rule.time}`;
    default: return '';
  }
}

let ruleCount = 0;
function renderRules(policy) {
  ruleCount = policy?.rules?.length || 0;
  $('ruleList').innerHTML = (policy?.rules || [])
    .map((r, i) => `<li style="animation-delay:${i * 60}ms"><span class="type">${esc(r.type)}</span><span class="src">“${esc(r.source)}”</span><span class="val">${esc(describe(r))}</span></li>`)
    .join('');
}

async function compile() {
  const btn = $('compile');
  btn.disabled = true;
  $('compileState').textContent = 'Compiling…';
  try {
    const policy = await api('/api/policy', { method: 'POST', body: JSON.stringify({ text: $('rules').value }) });
    renderRules(policy);
    const by = policy.compiledBy === 'gemini' ? 'Gemini' : 'local parser (Gemini unavailable)';
    $('compileState').textContent = `${policy.rules.length} rules enforced before every payment · compiled by ${by}`;
  } catch (e) {
    $('compileState').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}
$('compile').onclick = compile;

// --- wallet ------------------------------------------------------------------

$('connect').onclick = async () => {
  try {
    const { approveUrl } = await api('/api/wallet/connect', { method: 'POST' });
    window.location.href = approveUrl;
  } catch (e) {
    toast(e.message);
  }
};

// --- agent -------------------------------------------------------------------

function stepHtml(s) {
  const cls = DECISION_CLASS[s.status] || 'deny';
  const reason = s.reasons?.[0];
  const why = s.status === 'paid'
    ? `Within every rule → paid via PayPal <b>${esc(s.orderId || '')}</b>`
    : s.status === 'pending_approval'
      ? `${esc(reason?.message)} → sent to you for approval`
      : `${esc(reason?.message || '')}${reason?.source ? ` <span class="muted">(“${esc(reason.source)}”)</span>` : ''}`;
  const badge = s.status === 'pending_approval' && s.approveUrl
    ? `<a class="badge pending_approval" href="${esc(s.approveUrl)}">Review in PayPal →</a>`
    : `<span class="badge ${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const agent = s.agentWhy && s.status !== 'no_option' ? `<div class="agent-why">Agent: “${esc(s.agentWhy)}”</div>` : '';
  return `<li class="step ${cls}">
    <div class="icon">${ICONS[s.category] || '•'}</div>
    <div><div class="title">${esc(s.merchant)}<span class="amt">${s.amount ? money(s.amount) : ''}</span></div>${agent}<div class="why">${why}</div></div>
    ${badge}</li>`;
}

$('run').onclick = async () => {
  const btn = $('run');
  btn.disabled = true;
  const tl = $('timeline');
  tl.innerHTML = '<li class="empty">Agent is planning…</li>';
  try {
    // The server refuses to pay on an empty policy, so compile the rules on screen first.
    if (!ruleCount) await compile();
    const { steps } = await api('/api/agent/run', { method: 'POST', body: JSON.stringify({ trip: 'lisbon', request: $('request').value }) });
    tl.innerHTML = '';
    // Reveal attempts one by one so you can watch the leash work.
    for (const s of steps) {
      tl.insertAdjacentHTML('beforeend', stepHtml(s));
      await new Promise((r) => setTimeout(r, 450));
    }
    await refreshAudit();
  } catch (e) {
    tl.innerHTML = `<li class="empty">${esc(e.message)}</li>`;
  } finally {
    btn.disabled = false;
  }
};

// --- audit (AG Grid) ---------------------------------------------------------

const grid = agGrid.createGrid($('audit'), {
  rowData: [],
  getRowId: (p) => p.data.id,
  defaultColDef: { sortable: true, filter: true, resizable: true },
  columnDefs: [
    { field: 'time', headerName: 'Time', width: 110, valueFormatter: (p) => new Date(p.value).toLocaleTimeString() },
    { field: 'category', width: 110, valueFormatter: (p) => `${ICONS[p.value] || ''} ${p.value}` },
    { field: 'merchant', flex: 1, minWidth: 170 },
    { field: 'amount', width: 110, type: 'numericColumn', valueFormatter: (p) => (p.value ? money(p.value) : '—') },
    {
      field: 'status', width: 150,
      cellRenderer: (p) => `<span class="badge ${p.value}">${STATUS_LABEL[p.value] || p.value}</span>`,
    },
    { headerName: 'Why', flex: 2, minWidth: 240, valueGetter: (p) => p.data.reasons?.[0]?.message || (p.data.status === 'paid' ? 'Within all rules' : '') },
    { field: 'orderId', headerName: 'PayPal order', width: 190 },
  ],
});

async function refreshAudit() {
  const rows = await api('/api/audit');
  grid.setGridOption('rowData', rows);
  const paid = rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.amount, 0);
  const pending = rows.filter((r) => r.status === 'pending_approval').reduce((s, r) => s + r.amount, 0);
  const blocked = rows.filter((r) => r.status === 'blocked').length;
  $('spent').innerHTML = rows.length ? `Paid <b>${money(paid)}</b> · Awaiting you <b>${money(pending)}</b> · Blocked <b>${blocked}</b>` : '';
}

$('reset').onclick = async () => {
  await api('/api/reset', { method: 'POST' });
  $('timeline').innerHTML = '<li class="empty">Log cleared.</li>';
  refreshAudit();
};

// --- boot ----------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const MESSAGES = {
  wallet: { connected: '✓ Wallet connected — the agent can now pay within your rules', cancelled: 'Wallet connection cancelled', error: 'Wallet connection failed' },
  approval: { done: '✓ Approved and paid in PayPal', declined: 'You declined — nothing was charged', unknown: 'That approval link has expired' },
};
for (const [k, map] of Object.entries(MESSAGES)) if (map[params.get(k)]) toast(map[params.get(k)]);
if (params.toString()) history.replaceState(null, '', '/');

async function restoreLastRun() {
  const { steps } = await api('/api/agent/last');
  if (steps.length) $('timeline').innerHTML = steps.map(stepHtml).join('');
}

refreshStatus();
refreshAudit();
restoreLastRun();
