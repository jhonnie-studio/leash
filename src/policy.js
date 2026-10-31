// Deterministic policy engine. The LLM only *compiles* natural-language rules
// into this schema; every payment decision is made here, in plain code, so it
// is predictable, testable and auditable.

export const RULE_TYPES = [
  'max_unit_price',   // { category, amount, unit }      e.g. hotel <= $150 / night
  'budget',           // { category, amount }             total spend cap for the trip
  'approval_over',    // { amount }                       ask the human above this
  'block_attribute',  // { attribute }                    e.g. cancellation_fee
  'merchant_block',   // { merchants: [] }
  'merchant_allow',   // { merchants: [] }                only these merchants
  'min_rating',       // { category, value }
  'not_after',        // { category, time: "HH:MM" }     e.g. no dinners after 23:00
];

const DECISION_RANK = { allow: 0, approval: 1, deny: 2 };

const matchesCategory = (rule, purchase) =>
  !rule.category || rule.category === '*' || rule.category === purchase.category;

const money = (n) => `$${Number(n).toFixed(2)}`;

function spentIn(ledger, category) {
  return ledger
    .filter((e) => e.status === 'paid' || e.status === 'pending_approval')
    .filter((e) => !category || category === '*' || e.category === category)
    .reduce((sum, e) => sum + e.amount, 0);
}

function checkRule(rule, purchase, ledger) {
  if (!matchesCategory(rule, purchase)) return null;

  switch (rule.type) {
    case 'max_unit_price': {
      const unitPrice = purchase.unitPrice ?? purchase.amount;
      if (unitPrice > rule.amount) {
        return { decision: 'deny', message: `${money(unitPrice)}/${rule.unit || 'item'} is over your ${money(rule.amount)} limit` };
      }
      return null;
    }
    case 'budget': {
      const after = spentIn(ledger, rule.category) + purchase.amount;
      if (after > rule.amount) {
        const label = rule.category && rule.category !== '*' ? `${rule.category} budget` : 'total budget';
        return { decision: 'deny', message: `would bring ${label} to ${money(after)} (cap ${money(rule.amount)})` };
      }
      return null;
    }
    case 'approval_over':
      if (purchase.amount > rule.amount) {
        return { decision: 'approval', message: `${money(purchase.amount)} is above your ${money(rule.amount)} approval threshold` };
      }
      return null;
    case 'block_attribute':
      if (purchase.attributes?.[rule.attribute]) {
        return { decision: 'deny', message: `has ${rule.attribute.replace(/_/g, ' ')}, which you ruled out` };
      }
      return null;
    case 'merchant_block':
      if (rule.merchants.some((m) => m.toLowerCase() === purchase.merchant.toLowerCase())) {
        return { decision: 'deny', message: `${purchase.merchant} is on your blocked list` };
      }
      return null;
    case 'merchant_allow':
      if (!rule.merchants.some((m) => m.toLowerCase() === purchase.merchant.toLowerCase())) {
        return { decision: 'deny', message: `${purchase.merchant} is not on your allowed list` };
      }
      return null;
    case 'min_rating': {
      const rating = purchase.attributes?.rating;
      if (rating !== undefined && rating < rule.value) {
        return { decision: 'deny', message: `rated ${rating}, below your minimum of ${rule.value}` };
      }
      return null;
    }
    case 'not_after':
      if (purchase.time && purchase.time > rule.time) {
        return { decision: 'deny', message: `scheduled at ${purchase.time}, after your ${rule.time} cutoff` };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Evaluate a proposed purchase against a policy.
 * @returns {{decision: 'allow'|'approval'|'deny', reasons: {ruleId, source, message}[]}}
 */
export function evaluate(purchase, policy, ledger = []) {
  const reasons = [];
  let decision = 'allow';

  for (const rule of policy.rules) {
    const hit = checkRule(rule, purchase, ledger);
    if (!hit) continue;
    reasons.push({ ruleId: rule.id, source: rule.source, message: hit.message });
    if (DECISION_RANK[hit.decision] > DECISION_RANK[decision]) decision = hit.decision;
  }

  // Only keep the reasons that actually drove the final decision.
  const driving = reasons.filter((r) => {
    const rule = policy.rules.find((x) => x.id === r.ruleId);
    const ruleDecision = rule.type === 'approval_over' ? 'approval' : 'deny';
    return ruleDecision === decision;
  });

  return { decision, reasons: decision === 'allow' ? [] : driving };
}

/** Validate and normalise a compiled policy (LLM output is untrusted). */
export function sanitizePolicy(raw) {
  const rules = Array.isArray(raw?.rules) ? raw.rules : [];
  const clean = [];
  for (const [i, r] of rules.entries()) {
    if (!RULE_TYPES.includes(r?.type)) continue;
    const rule = { id: r.id || `r${i + 1}`, type: r.type, source: String(r.source || '').slice(0, 200) };
    if (r.category) rule.category = String(r.category).toLowerCase();
    if (['max_unit_price', 'budget', 'approval_over'].includes(r.type)) {
      const amount = Number(r.amount);
      if (!Number.isFinite(amount) || amount < 0) continue;
      rule.amount = amount;
      if (r.unit) rule.unit = String(r.unit);
    }
    if (r.type === 'block_attribute') {
      if (!r.attribute) continue;
      rule.attribute = String(r.attribute);
    }
    if (r.type === 'merchant_block' || r.type === 'merchant_allow') {
      if (!Array.isArray(r.merchants) || !r.merchants.length) continue;
      rule.merchants = r.merchants.map(String);
    }
    if (r.type === 'min_rating') {
      const value = Number(r.value);
      if (!Number.isFinite(value)) continue;
      rule.value = value;
    }
    if (r.type === 'not_after') {
      if (!/^\d{2}:\d{2}$/.test(r.time || '')) continue;
      rule.time = r.time;
    }
    clean.push(rule);
  }
  return { currency: 'USD', rules: clean };
}
