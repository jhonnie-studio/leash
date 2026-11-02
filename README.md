# Leash

**Give your AI agent a PayPal wallet — on a leash.**

AI agents are starting to buy things for us. The hard question isn't *can* an agent pay — it's *should it have paid for that?* Leash lets you write spending rules in plain English, turns them into a strict policy with Gemini, and checks **every** payment against that policy in deterministic code *before* PayPal is ever called.

> "Never more than $150 a night. No hotels with cancellation fees. Ask me before anything over $300."

The agent books your trip. When it reaches for the $240/night rooftop hotel, Leash pulls it back, says exactly why, and the agent tries the next option.

![Leash UI](docs/screenshot.png)

---

## How it works

```mermaid
flowchart LR
  U[You] -- plain-English rules --> G[Gemini<br/>rule compiler]
  G -- strict JSON policy --> P[(Policy)]
  U -- one-time approval --> V[PayPal Vault<br/>payment token]
  A[Travel agent<br/>Gemini ranks options] -- proposed purchase --> E{Policy engine<br/>deterministic code}
  P --> E
  E -- allow --> C[PayPal Orders v2<br/>charge vaulted token]
  E -- ask you --> H[PayPal checkout link<br/>human approves]
  E -- block + reason --> A
  C & H --> L[(Audit log<br/>AG Grid)]
```

| Decision | When | What happens in PayPal |
|---|---|---|
| ✅ **Allow** | Inside every rule | Order created and captured against the **vaulted** payment token — no human needed |
| ⏸ **Ask you** | Allowed, but above your approval threshold | A normal PayPal checkout link is created; nothing moves until **you** approve it |
| ❌ **Block** | Breaks any rule | No PayPal call at all. The exact rule and reason go back to the agent, which tries the next option |

**The model never makes the yes/no call.** Gemini only (1) translates your words into a typed policy and (2) ranks travel options by taste. The decision lives in [`src/policy.js`](src/policy.js) — ~150 lines of plain code with unit tests — so a clever prompt can't talk the agent past your limits. LLM output is validated (`sanitizePolicy`) before it is trusted.

### PayPal integration
- **Vault (setup token → payment token):** you authorise the agent's wallet once; the agent holds a revocable payment token, never credentials. ([`src/paypal.js`](src/paypal.js))
- **Orders v2 with `vault_id`:** autonomous captures for allowed purchases, each with a `PayPal-Request-Id` for idempotency.
- **Orders v2 checkout link:** the human-in-the-loop path for big purchases, captured on return.
- Sandbox only. No real money moves.

### Rule types
`max_unit_price` · `budget` · `approval_over` · `block_attribute` (cancellation fees, basic economy, overnight layovers) · `merchant_block` / `merchant_allow` · `min_rating` · `not_after`

Budgets count both paid **and** pending-approval spend, so the agent can't queue up approvals that would blow your cap.

Leash fails closed: with no compiled rules the agent is refused, so it can never pay on an empty policy.

### Audit log (AG Grid Community)
Every attempt is a row: paid, held for you, or blocked. Rows are colour-coded by decision. A **Your rule** column shows the exact sentence you wrote that drove the decision. Hover a merchant to see the agent's reasoning. A pinned totals row, quick-filter search and **Export CSV** make it a record you can actually hand to someone.

---

## Try it

**Live demo:** https://leash-dk04.onrender.com

> Free hosting: if the demo has been idle, the first load can take up to a minute while it wakes up. It is a single shared demo session, so you may see someone else's last run; click **Clear log** to start fresh.

1. **Connect wallet** → approve in the PayPal sandbox.
2. **Compile rules** — the six example rules are pre-filled.
3. **Send the agent** — watch it get blocked, re-plan, pay, and ask you.
4. Click **Review in PayPal** on a held item to approve it yourself.

### Sandbox test buyer
Use any sandbox **personal** account from your PayPal Developer dashboard (Testing Tools → Sandbox Accounts).

---

## Run locally

```bash
git clone https://github.com/jhonnie-studio/leash && cd leash
npm install
npm start            # http://localhost:3000
```

Each Gemini call times out after 8 s and tries the next model; if all fail, Leash uses its local parser for a minute so the demo never hangs. Every compile result says which one was used (`compiledBy`).

Without credentials Leash runs in **mock mode** (fake PayPal IDs, a local rule parser instead of Gemini) so you can explore the whole flow offline. For the real thing, set:

| Variable | Purpose |
|---|---|
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | PayPal **sandbox** REST app with *Save payment methods* enabled |
| `GEMINI_API_KEY` | Google AI Studio key |
| `GEMINI_MODEL` | optional, defaults to `gemini-3.8-flash`. Comma-separated list = fallbacks tried in order, e.g. `gemini-3.8-flash,gemini-flash-lite-latest` |
| `PUBLIC_URL` | where PayPal should redirect back, e.g. `https://leash.onrender.com` |
| `DEMO_PAYMENT_TOKEN_ID` | optional: a sandbox vault payment token loaded at startup, so visitors can run the agent without their own PayPal sandbox login |

```bash
npm test             # 16 tests: policy engine + full agent flow in mock mode
```

**Deploy:** one click with the included [`render.yaml`](render.yaml) Blueprint on Render.

---

## Project structure

```
src/
  policy.js     deterministic policy engine + LLM-output sanitizer
  gemini.js     rule compiler and option ranking (Gemini), offline fallback
  paypal.js     Vault setup, vaulted charges, approval orders (sandbox)
  inventory.js  fictional Lisbon trip inventory
  server.js     Express API + agent loop
public/         UI (vanilla JS + AG Grid Community)
test/           node:test suites
```

## What's next
- Per-merchant and per-day limits, and rules that expire.
- Webhooks (`PAYMENT.CAPTURE.COMPLETED`, disputes) feeding the audit log.
- A Leash SDK any agent framework can call before it pays.
- Multi-user persistence (currently a single in-memory demo session).

## How it was built
Leash was conceived and directed by **Naif** and built with AI tools: **Claude Code** (code, tests, UI) working alongside **Jhonnie**, an AI agent that handled setup, credentials and deployment. All travel merchants in the demo are fictional.

## License
[MIT](LICENSE)
