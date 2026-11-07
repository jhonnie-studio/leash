// PayPal sandbox integration.
//  - Vault setup: the human approves the agent's wallet once (setup token -> payment token).
//  - Autonomous payment: Orders v2 charged against the vaulted payment token.
//  - Human approval: an Orders v2 checkout link the human approves themselves.
// Without credentials the module runs in mock mode with clearly fake IDs.

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

export const paypalEnabled = Boolean(CLIENT_ID && CLIENT_SECRET);

// Counts payment calls (charge, approval order, capture) so tests can prove the
// emergency stop really keeps the agent away from PayPal.
export const stats = { paymentCalls: 0 };

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function api(method, path, body, requestId) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`PayPal ${method} ${path} ${res.status}: ${data.message || text}`);
  return data;
}

const mockId = (prefix) => `MOCK-${prefix}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const approveLink = (data) => data.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href;

const purchaseUnit = (purchase) => ({
  reference_id: purchase.optionId,
  description: `${purchase.merchant} (${purchase.category}) — booked by Leash agent`.slice(0, 127),
  amount: { currency_code: 'USD', value: purchase.amount.toFixed(2) },
});

/** Step 1 of wallet setup: returns a link the human opens once to authorise the agent. */
export async function createWalletSetup(returnUrl, cancelUrl) {
  if (!paypalEnabled) return { setupTokenId: mockId('SETUP'), approveUrl: `${returnUrl}?approval_token_id=mock`, mock: true };
  const data = await api('POST', '/v3/vault/setup-tokens', {
    payment_source: {
      paypal: {
        usage_type: 'MERCHANT',
        experience_context: { return_url: returnUrl, cancel_url: cancelUrl, brand_name: 'Leash' },
      },
    },
  });
  return { setupTokenId: data.id, approveUrl: approveLink(data) };
}

/** Step 2: exchange the approved setup token for a reusable payment token. */
export async function finishWalletSetup(setupTokenId) {
  if (!paypalEnabled) return { paymentTokenId: mockId('VAULT'), mock: true };
  const data = await api('POST', '/v3/vault/payment-tokens', {
    payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } },
  });
  return { paymentTokenId: data.id };
}

/** Autonomous charge against the vaulted wallet. Only called after the policy engine said "allow". */
export async function chargeVaulted(purchase, paymentTokenId, requestId) {
  stats.paymentCalls++;
  if (!paypalEnabled || !paymentTokenId || paymentTokenId.startsWith('MOCK')) {
    return { orderId: mockId('ORDER'), captureId: mockId('CAPTURE'), status: 'COMPLETED', mock: true };
  }
  const order = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit(purchase)],
    payment_source: { paypal: { vault_id: paymentTokenId } },
  }, requestId);
  let status = order.status;
  let captureId = order.purchase_units?.[0]?.payments?.captures?.[0]?.id;
  if (status !== 'COMPLETED') {
    const cap = await api('POST', `/v2/checkout/orders/${order.id}/capture`, {}, `${requestId}-cap`);
    status = cap.status;
    captureId = cap.purchase_units?.[0]?.payments?.captures?.[0]?.id;
  }
  return { orderId: order.id, captureId, status };
}

/** Human-in-the-loop: create an order the human approves in PayPal themselves. */
export async function createApprovalOrder(purchase, returnUrl, cancelUrl, requestId) {
  stats.paymentCalls++;
  if (!paypalEnabled) {
    const orderId = mockId('ORDER');
    return { orderId, approveUrl: `${returnUrl}?token=${orderId}`, mock: true };
  }
  const order = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit(purchase)],
    payment_source: {
      paypal: {
        experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', brand_name: 'Leash' },
      },
    },
  }, requestId);
  return { orderId: order.id, approveUrl: approveLink(order) };
}

export async function captureApprovedOrder(orderId) {
  stats.paymentCalls++;
  if (!paypalEnabled || orderId.startsWith('MOCK')) return { captureId: mockId('CAPTURE'), status: 'COMPLETED', mock: true };
  const cap = await api('POST', `/v2/checkout/orders/${orderId}/capture`, {});
  return { captureId: cap.purchase_units?.[0]?.payments?.captures?.[0]?.id, status: cap.status };
}
