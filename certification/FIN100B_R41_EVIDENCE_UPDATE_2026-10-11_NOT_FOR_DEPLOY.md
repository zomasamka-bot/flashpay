# FLASHpay R41 evidence update — 2026-10-11

STATUS: REVIEW ONLY / R4 NOT FOR DEPLOY. FIN100B still OPEN.

Uploaded original ZIP SHA256: 4c7bbacbb414d5577e229b85e8304e5c51129f1b3ed2574ba5c63fc5019fd05c

SOURCE REVIEW: The user-provided exact R4 ZIP ALREADY CONTAINS all FIVE independent evidence predicates and both A2U rejection checks in `lib/db.ts`. No financial kernel patch was needed or made. Source file SHA256: e5e229a2a8533d3dd906f8bc0385f232cc6768ad78fd2a122dcd1127a6ff5885.

Source confirmed: `recoverInitialPaymentProjectionUnderDurableGuard` checks refund_checkpoints, financial_pi_mutation_attempts, settlement_u2a_approval_retirements, settlement_a2u_stage1_retirements, settlement_a2u_ongoing_observations inside the same durable advisory-locked transaction, rejecting `persist()` for any positive evidence.

User-shared Mac Terminal results (DO NOT misrepresent as rerun on packaged ZIP):
R41.27M/N/O Redis recovery and PG evidence  PASS, isolated with test-only executor bypass.
R41.28H/I/J-R2 source/export/TypeScript module loading PASS.
R41.28K-R2 NEW classifier PASS; initial 28K harness timed out then isolated process PID 273 was signalled.
R41.28L CREATED -> REPLAY/REPLAYED original ID -> changed-amount CONFLICT; fixture cleaned=true.
R41.28M advanced U2A checkpoint evidence CONFLICT, persist callbacks 0, fixture cleaned=true.
R41.28O independent Pi mutation evidence CONFLICT, callbacks 0, cleaned=true.
R41.28R other four evidence tables each independently CONFLICT, callbacks 0, fixture cleaned=true.
R41.28S missing dedicated database yields INDETERMINATE and no callback; NOT evidence-query failure after connected DB.
R41.28T R41_02_REMAINING=0, R41_01_CHECKPOINT=1, TOTAL_SETTLEMENT_CHECKPOINTS=1.
V4 guard blocked count 0 only measures blocked attempts, not independently observed packet count.

OPEN: R41.28U targeted evidence-query error with healthy PG connection + snapshots; current ZIP regression and full build not rerun; parity with Desktop tested runtime not independently byte verified; real HTTP create flow and cross-instance tests not certified. R41-01 CLOSED within isolated scope; R41-02 ACTIVE; R41-03..10 OPEN; 1/10 tests CLOSED. R4 NOT FOR DEPLOY.

All existing bytes in the ZIP are kept IDENTICAL; this reissued package adds this evidence note only. No application source, financial tables, Redis, Pi/Horizon or production was modified in this packaging step.
