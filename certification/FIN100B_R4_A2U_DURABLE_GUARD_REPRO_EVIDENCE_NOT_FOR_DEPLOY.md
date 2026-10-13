# FIN-100B R4 / Durable A2U Evidence Guard / NOT FOR DEPLOY

Baseline: R3 FIN17 scanner-fixed ZIP, 2026-10-10.

## Reproduction (R3, isolated test only)

`BD05_A2U_GAP_RESULT=GUARD_GAP_REPRODUCED` / `A2U_GAP_REPLAY_HTTP=200` /
`A2U_GAP_PENDING_REBUILT=YES` / `A2U_GAP_TEST_EXIT=2`.
A newly created synthetic payment had one durable create-intent row and one
version-1 `payment_identity` checkpoint. After inserting a **synthetic**
`settlement_a2u_ongoing_observations` row and deleting only that payment's
isolated Redis projection, replay returned HTTP 200 and rebuilt `pending`.
No real Pi operation, settlement or refund was performed.

## Change

`lib/db.ts::recoverInitialPaymentProjectionUnderDurableGuard` now refuses
initial pending projection recovery if EITHER of these append-only financial
records exists for that payment:

- `settlement_a2u_ongoing_observations`
- `settlement_a2u_stage1_retirements`

The previously guarded `refund_checkpoints`, `financial_pi_mutation_attempts`,
and `settlement_u2a_approval_retirements` checks are retained unchanged.
The read executes under the existing transaction, advisory payment lock, and
row locks; the Redis persist callback remains after the checks. The tables
are initialized by `ensureSettlementCheckpointTable` on the payment API path.
A DB read/schema error remains fail-closed (`INDETERMINATE`).

## Verification and release limits

A new source-level regression assertion is included. Source assertions
are NOT a replacement for R4 HTTP replay of the same synthetic fixture,
normal newly-created payment and healthy Redis recovery, multi-instance
races, and Next.js production build. R4 has NOT been deployed or live-certified.
R41 original ten-case contract remains OPEN; FIN-100 overall OPEN.
Production deploy is NOT AUTHORIZED.
