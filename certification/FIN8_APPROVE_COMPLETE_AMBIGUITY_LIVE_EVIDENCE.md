# FIN-8 — Approve / Complete Ambiguity LIVE Certification Evidence

## Permanent certification-hook contract

FIN-8 retains a narrowly scoped production certification hook so reviewers can reproduce and audit the exact LIVE ambiguity boundary. The hook is **not** general business behavior and **does not** authorize a financial mutation.

The hook can activate only when all of these predicates are simultaneously true:

1. `VERCEL_ENV === "production"`.
2. Canonical Pi payment network is exactly `Pi Testnet`.
3. Canonical Pi payment amount is exactly `0.20 Pi`.
4. FlashPay payment identity exactly equals the server-only `FLASHPAY_FIN8_LIVE_PAYMENT_ID` value.
5. Execution has already crossed the durable FIN-7 one-shot attempt claim and the external Pi POST has returned.

If `FLASHPAY_FIN8_LIVE_PAYMENT_ID` is absent, blank, whitespace-padded, or names another payment, the FIN-8 hook is inert. Amount `0.20` by itself is never sufficient authority.

### Approve ambiguity boundary

`/api/pi/approve` order is:

`canonical validation -> durable approval ownership -> fin7_v1 one-shot attempt -> Pi /approve POST -> FIN8 response-loss hook -> response consumption -> exact Pi GET reconciliation`.

The injected 503 occurs after Pi POST returns and before FlashPay consumes the POST response. A replay therefore cannot infer POST failure. The existing durable attempt has already been consumed; replay reconciles canonical Pi state before considering any side effect, and a second `/approve` POST is forbidden.

### Complete ambiguity boundary

`/api/pi/complete` order is:

`exact U2A verification -> durable verified checkpoint -> fin7_v2 u2a_complete one-shot attempt -> Pi /complete POST -> FIN8 response-loss hook -> response consumption -> exact Pi GET reconciliation -> durable completed checkpoint`.

The primary route and transient recovery share the same `u2a_complete` mutation authority. Transient recovery performs exact Pi GET first. If Pi proves `developer_completed=true`, it persists completion without a second POST. If Pi does not prove completion, the already-consumed attempt prevents a second POST and the path fails closed/reconcile-only.

## DR11 separation — permanent 0.10 Pi hook

FIN-8 does **not** reuse, alter, remove, or broaden the existing DR11 `0.10 Pi` Testnet production certification path. DR11 remains dedicated to automatic Refund certification and retains its durable refund hold/XOR ordering. FIN-8 uses `0.20 Pi` only, with exact payment-identity arming in addition to amount/network/environment gates.

## Build-time enforcement

`scripts/verify-fin8-live-approve-complete-ambiguity-hook.mjs` fails the build if the FIN-8 scope broadens, the exact payment-ID gate disappears, the 0.20/Testnet/production gates disappear, either hook moves outside the intended post-POST/pre-reconciliation boundary, transient recovery ceases to reconcile first, or DR11's 0.10 refund certification hook disappears.

## LIVE evidence status

Instrumentation: READY FOR DEPLOYMENT.

LIVE Approve ambiguity: OPEN until a controlled 0.20 Pi Testnet fixture is armed and observed.

LIVE Complete ambiguity: OPEN until the same controlled fixture crosses the completion boundary and recovery evidence is captured.

FIN-8 remains OPEN until LIVE evidence proves no duplicate mutation POST and exact canonical reconciliation for both stages.
