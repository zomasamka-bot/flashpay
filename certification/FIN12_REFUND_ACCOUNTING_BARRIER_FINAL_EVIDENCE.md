# FIN-12 — Refund Accounting Barrier — Final Evidence

Baseline production SHA inspected: `dce35f846983d1a11a3121377255b6e63a7c442c`

## Scope
FIN-12 proves that a refund cannot become durably completed or finally projected unless the exact refund identity, amount, Horizon fee, durable accounting row, prerequisite audit chain, and completion event all agree. Redis remains projection only.

## Authoritative chain
`wallet_submission_confirmed -> payment_checkpoint_updated -> accounting_recorded -> audit_recorded/pending -> audit_recorded/completed -> final projection`

## Adversarial matrix
The FIN-12 certifier binds and mutation-tests the following fail-closed predicates:
- missing accounting row;
- duplicate/conflicting accounting identity;
- wrong payment/refund payment/refund tx identity;
- wrong payer or amount;
- invalid/negative Horizon fee and fee mismatch;
- missing prerequisite audit event;
- duplicate prerequisite event;
- wrong audit payment/idempotency/actor/event identity;
- wrong refundPaymentId/refundTxid audit details;
- wrong accounting/audit Horizon fee details;
- premature checkpoint completion;
- premature final projection;
- duplicate/non-canonical final projection event;
- crash/replay around accounting, audit, completion, Redis final projection, and durable projection-finalized evidence.

## Durable barriers
- `refund_accounting_records` uniquely binds `refund_id`, `payment_id`, `refund_payment_id`, and `refund_txid`.
- Accounting insertion is idempotent; replay is accepted only for one exact matching durable row.
- Completion requires exactly four prerequisite audit event types with exact identity/details and exact accounting fee.
- The only refund checkpoint `status='completed'` writer is `completeRefundCheckpointWithAudit`, behind the full accounting/audit barrier.
- Final projection requires `audit_recorded + completed`, exact accounting, and exactly one exact `refund_completed` event.
- If Redis is already `refunded` after a crash, recovery still calls `finalizeRefundProjectionWithAudit`; Redis alone cannot establish durable finality.

## Automated proof
`FIN12_REFUND_ACCOUNTING_BARRIER_ADVERSARIAL=PASS predicates=33 mutations_killed=33 runtime_kernel_changed=false`

Existing FIN-6 accounting/finality certification remains:
`FIN6_ACCOUNTING_FINALITY_MATRIX=PASS source_invariants=32 runtime_financial_delta=ZERO`

## Runtime impact
No file under `app/` or `lib/` is changed by FIN-12 certification. Only certification/build-verifier surfaces are added or updated.

## Pre-production verdict
`FIN-12 = FULL PASS / PRE-PRODUCTION CERTIFIED / NO RUNTIME PATCH`

Final `CLOSED` status requires the resulting source to be published and the exact production deployment/build to be matched to its Git SHA with the FIN-12 certifier visibly passing.
