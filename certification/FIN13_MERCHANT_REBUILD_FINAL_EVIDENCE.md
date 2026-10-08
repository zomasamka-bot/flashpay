# FIN-13 — Merchant Rebuild — Final Evidence

Baseline production SHA inspected: `31e3e7055910f6e87df6fa1c14d7a24069cab8f7`

## Scope
FIN-13 proves merchant settled accounting is reconstructible and independently verifiable from durable PostgreSQL receipts, without Redis as financial truth and without adding a new financial writer when no mismatch exists.

## Canonical equation
For every merchant in the union of `merchant_balances` and canonical settled receipts:
`merchant_balances.settled == SUM(receipts.merchant_amount WHERE settlement_status='settled_to_merchant')`
and `merchant_balances.unsettled == 0`.

## Live production read-only proof — 2026-10-08
Executed against production PostgreSQL inside a `READ ONLY` transaction with forced rollback; no DB write, Redis mutation, Pi mutation, or Horizon submission was performed.

Observed:
- `merchantBalanceMismatchCount = 0`
- `duplicateIdentityCount = 0`
- `refundDuplicateIdentityCount = 0`
- `merchant_balances = 29`
- canonical merchants with settled receipts = `5`
- stored settled total = `101.02000000 π`
- canonical settled receipt total = `101.02000000 π`
- receipts = `304`
- refund accounting records = `54`
- refund checkpoints = `56`

## Adversarial/static proof
The FIN-13 certifier binds and mutation-tests:
- canonical balance derives only from durable settled receipts;
- union coverage detects missing balance rows and orphan/stale balance rows;
- settled mismatch and any non-zero unsettled value fail reconciliation;
- duplicate transaction/receipt/A2U identities are surfaced;
- refund accounting duplicate identities are surfaced separately;
- receipt insertion is idempotent and merchant credit occurs only when the receipt is newly inserted;
- merchant credit uses exact `merchantAmount`;
- `merchant_balances.merchant_id` is unique by primary key;
- refund accounting uses its separate durable table and does not mutate `merchant_balances`;
- R100-1 merchant accounting truth has no Redis dependency.

Automated proof:
`FIN13_MERCHANT_REBUILD_ADVERSARIAL=PASS predicates=22 mutations_killed=22 redis_financial_truth=false refund_balance_contamination=false runtime_kernel_changed=false`

Existing FIN-6 remains:
`FIN6_ACCOUNTING_FINALITY_MATRIX=PASS source_invariants=32 runtime_financial_delta=ZERO`

## Architecture decision
No generic merchant rebuild writer is added. Current durable state is reconciled exactly, and adding another financial writer without a proven defect would increase mutation/concurrency/crash surface without financial benefit. If a future reconciliation mismatch is proven, repair must be evidence-gated and fail closed rather than silently treating Redis or a derived cache as truth.

## Runtime impact
No file under `app/` or `lib/` is changed by FIN-13 certification. Only certification/build-verifier surfaces are added or updated.

## Pre-production verdict
`FIN-13 = FULL PASS / PRE-PRODUCTION CERTIFIED / NO RUNTIME PATCH`

Final `CLOSED` requires publication and exact Git SHA ↔ Vercel production deployment/build correspondence with the FIN-13 certifier visibly passing.
