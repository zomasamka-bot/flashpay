# FIN-8 — Approve / Complete Ambiguity LIVE — FINAL / FULL PASS

Final LIVE closure: 2026-10-08
Production source SHA tested: `79fc34a06c2dc17d62a4826b92bd13ecd14d56f8`
LIVE fixture: `4336a5c1-6efb-49e4-bf78-6a441f58ee93` — `0.20 Pi` — `Pi Testnet`.

## Permanent certification hooks

The FIN-8 0.20 hook remains in source as controlled certification instrumentation. It is inert unless **all** gates match: production + Pi Testnet + exactly 0.20 Pi + exact server-side `FLASHPAY_FIN8_LIVE_PAYMENT_ID`. Absence of that env key leaves the hook unarmed; amount alone can never activate it.

The existing **0.10 Pi Testnet DR11 hook is separate and permanent**. It is dedicated only to automatic Refund certification and its durable refund-hold/XOR ordering. FIN-8 does not remove, broaden, or repurpose DR11.

## LIVE result

The controlled fixture crossed the post-POST response-loss ambiguity boundary and recovered without blind financial retry.

- Final settlement checkpoint: `db_finalized`.
- Amounts: customer `0.20000000`, merchant `0.20000000`, commission `0.00000000`.
- U2A Pi payment: `TVuKfhnzQJi61dOul0dvqhUca829`.
- U2A Horizon txid: `d589a1e5e87b2c63dc3e47133df97e37c5a32c627b73fb7d71c9718601c0c8b7`.
- A2U Pi payment: `ZLNQi0hkcCNJPhpc4629IaH5t3ls`.
- Prepared A2U hash = finalized A2U txid: `75f931f986fd72674ab777125050c9d692f6d800c2f8c3dfc5816e89d82f3702`.
- Durable approval guard: `fin7_v1`.
- Durable Pi mutation guard: `fin7_v2`.
- `u2a_complete` durable attempts: exactly 1.
- `a2u_complete` durable attempts: exactly 1.
- Canonical Pi state proved both payments verified/completed on Pi Testnet.
- Horizon proved both native payment movements successful with exact 0.20 amount/direction.
- Post-test global verifier: `FIN6_ACCOUNTING_FINALITY_MATRIX=PASS source_invariants=32 runtime_financial_delta=ZERO`.

## Closure predicate

Approve ambiguity PASS; U2A Complete ambiguity PASS; A2U Complete PASS; no blind retry PASS; canonical reconciliation PASS; Horizon settlement PASS; Pi completion PASS; DB finality PASS; accounting/XOR PASS.

Therefore **FIN-8 = FULL PASS / CLOSED**.

After evidence capture the production `FLASHPAY_FIN8_LIVE_PAYMENT_ID` was removed and production was redeployed, leaving the permanent hook present but unarmed. Reproduction requires explicit re-arming with a new exact fixture; reviewers must never retry an ambiguous payment blindly.
