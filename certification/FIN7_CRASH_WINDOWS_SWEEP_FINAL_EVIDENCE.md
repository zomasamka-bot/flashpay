# FIN-7 — Crash Windows Sweep — FINAL / FULL PASS

Final closure: 2026-10-08
Canonical model: 41 financial crash windows.

## Final decision

FIN-7 is **FULL PASS / CLOSED**. The canonical 41-window model is bound to the current FIN5 + FIN7-S1/S2/S3/S4 runtime. FIN-7.5 durable-state proof and current-source binding passed; no separate FIN-7 live crash injection was required because Pi Approve/Complete external ambiguity is certified by FIN-8 and Horizon submit ambiguity is reserved for FIN-9.

## Closed runtime authorities

- S1 — Settlement submit: PostgreSQL durable `prepared` checkpoint/XDR/hash is required before Horizon submit; Redis is never submit authority.
- S2 — U2A approve: durable `fin7_v1` one-shot attempt; replay reconciles canonical Pi first and POST is allowed only for a freshly `RECORDED` attempt.
- S3 — Pi mutation families: durable `fin7_v2` one-shot authority for U2A cancel/complete, A2U complete, DR11 orphan cancel and refund complete; consumed attempts are never reopened by uncertainty.
- S4 — Refund create: durable one-shot create attempt; crash after claim cannot authorize a second Pi create.

## Governing semantics

PostgreSQL durable evidence plus verified Pi/Horizon evidence is financial truth. Redis is coordination/projection only. Money-moved windows reconcile against canonical external truth and never rebuild/repeat movement blindly. Uncertainty or conflict fails closed. Settlement XOR Refund remains mandatory.

## Final certifier evidence

- `CRASH_POLICY_CERTIFIER=PASS windows=41 one_shot_retry=NEVER`
- `PLAN_H_CRASH_POLICY_BINDING=PASS modeled_windows=41 u2a_complete_reconcile=true settlement_submit_durable=true refund_ambiguity_bound=true blind_retry=false`
- `FIN7_CRASH_WINDOWS_CURRENT_SOURCE=PASS windows=41 runtime_kernel_unchanged=true live_crash_required=false`

FIN-7 closure introduced no Mainnet enablement, commission enablement, dependency/UI change, or weakening of financial invariants.
