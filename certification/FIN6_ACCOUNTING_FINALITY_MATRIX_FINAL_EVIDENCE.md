# FIN-6 — Accounting / Finality Matrix — Final Evidence

Date: 2026-10-07  
Baseline Git SHA: c8a1c4b3c073dc7880f13e8cdd376a154fed4cab  
Baseline Production Deployment: dpl_EzVxXForpxEGdhCsq7YK48ZA7adb  
Production Alias: flashpay-two.vercel.app

## Verdict

FIN-6 ACCOUNTING / FINALITY MATRIX: FULL PASS

All required accounting/finality closure predicates were proven without a financial-runtime patch and without new Pi spend.

- Settlement / Refund final overlap: 0
- Missing accounting finality: 0
- Duplicate finality: 0
- Amount mismatch: 0
- Application commission violation: 0
- False settled finality: 0
- False refunded finality: 0
- Unexplained Horizon outbound movement after full reconciliation: 0

## Financial Authority Contract

Financial truth remains durable PostgreSQL evidence plus verified Pi Platform / Horizon evidence. Redis remains coordination/cache/projection only and is not financial truth. Settlement XOR Refund remains mandatory.

Current accounting contract:
- customerAmount = merchantAmount
- appCommission = 0
- appNetImpact = customerAmount - merchantAmount - horizonFeeCharged

The Horizon/network fee is distinct from FlashPay application commission. FIN-6 does not enable or design a future FlashPay merchant commission.

## Settlement Durable Matrix

Observed settlement checkpoints:
- total: 95
- db_finalized: 43
- payment_identity: 52
- finalized accounting-invariant violations: 0
- finalized missing durable evidence: 0
- duplicate A2U payment IDs: 0
- duplicate A2U txids: 0
- duplicate prepared hashes: 0

The durable schema requires final settlement evidence including prepared transaction identity, Horizon confirmation, Pi completion and DB finalization timestamps. DB finalization is gated on the pi_completed stage and exact receipt evidence.

## Settlement / Refund XOR

Final settlement/refund overlap:
- true final overlap: 0
- overlaps involving final settlement: 0
- identity-only settlement checkpoints associated with refund history: 21
- completed-refund identity-only cases: 20
- pending-refund identity-only cases: 1

Identity-only checkpoints are not settlement finality. Therefore Settlement XOR Refund holds for all final states.

## Settlement Receipt / Accounting Linkage

Finalized checkpoint-backed settlements:
- finalized checkpoints: 43
- with matching A2U receipt: 43
- with matching U2A receipt: 43
- without matching receipt: 0
- exact receipts: 43
- receipts with transaction: 43
- customer amount mismatches: 0
- merchant amount mismatches: 0
- application commission violations: 0
- A2U identifier mismatches: 0
- A2U txid mismatches: 0
- U2A identifier mismatches: 0
- U2A txid mismatches: 0
- receipt status mismatches: 0
- transaction amount mismatches: 0
- transaction merchant mismatches: 0

The canonical appNetImpact formula is `customerAmount - merchantAmount - horizonFeeCharged`. A value such as -0.01 when the Horizon fee is 0.01 is therefore correct internal accounting under the current zero-commission/equal-amount contract.

## Refund Finality / Accounting

Refund checkpoints:
- total checkpoints: 56
- completed audit_recorded: 54
- wallet_submission_started / pending: 1
- wallet_submission_started / manual_review_required: 1

Refund accounting:
- accounting records: 54
- completed refunds with accounting: 54
- completed refunds missing final evidence: 0
- completed accounting mismatches: 0
- completed refund with final settlement: 0
- non-final refund with accounting: 0
- non-final refund with refund txid: 0

The two non-final cases remain fail-closed and do not invent financial finality.

## Forward DB -> Horizon Reconciliation

Settled receipts:
- total settled receipts: 191
- Horizon verified: 191
- checkpoint-backed: 43 / 43 verified
- historical/legacy retained receipts: 148 / 148 verified
- not found: 0
- unsuccessful: 0
- hash mismatch: 0
- fee mismatch: 0
- indeterminate: 0

Completed refunds:
- completed refunds: 54
- Horizon verified: 54
- not found: 0
- unsuccessful: 0
- hash mismatch: 0
- fee mismatch: 0
- indeterminate: 0

Combined forward final movements verified: 245 / 245.

## Reverse Horizon -> Ledger / Pi Reconciliation

Application wallet: `GCVYA2KC6ANJOW4OMOSUKFLSBMZDYQWZ4S6HA654MIWHG6NZC4ZZOVD5`

Full Pi Testnet Horizon payment scan:
- Horizon payment operations scanned: 784
- distinct outbound native payment transactions: 293
- current DB settlement txids: 191
- current DB refund txids: 54
- current DB explained distinct outbound txids: 245
- initially historical/unexplained outbound txids: 48

The remaining 48 were reconciled read-only against Pi Platform and Horizon. For all 48:
- Pi payment found: 48 / 48
- Horizon memo equals Pi payment identifier: 48 / 48
- direction = app_to_user: 48 / 48
- transaction_verified = true: 48 / 48
- developer_completed = true: 48 / 48
- cancelled = false: 48 / 48
- metadata.type = a2u_settlement: 48 / 48
- transaction txid matches Horizon: 48 / 48
- amount matches: 48 / 48
- destination matches: 48 / 48
- source matches application wallet: 48 / 48
- legacy reconciliation failures: 0

Final reverse reconciliation:

293 Horizon outbound =
191 current settled receipt txids +
54 refund txids +
48 historical Pi-verified FlashPay A2U settlements.

- total explained distinct outbound: 293
- remaining unexplained: 0
- cross-class duplicate txids: 0

## Historical Boundary

The 48 historical A2U settlements occurred between 2026-05-15 and 2026-07-17. Current DB contains no retained transaction, receipt, settlement checkpoint or refund checkpoint rows for their historical internal payment UUIDs.

Git history shows the settlement-status/accounting persistence implementation was introduced in source on 2026-07-17 by commit `b98e8cef53230af59848f6f9a8c62c0e5eb0a90b`. Current retained final receipt population begins on 2026-07-21. The Git date is treated as a source-history boundary, not proof of an exact production deployment timestamp. No synthetic DB backfill was performed.

## Canonical Finality Predicate

Settlement finality requires all canonical predicates including:
- status = settled_to_merchant
- piCompleted = true
- dbRecorded = true
- requiresDbReconciliation = false
- horizonSuccessFlag = true
- piCompletionPending = false
- valid merchant/payment identities
- valid U2A/A2U transaction hashes
- amount = customerAmount = merchantAmount
- non-negative Horizon fee
- appCommission = 0
- exact appNetImpact formula
- valid Horizon/settlement timestamps

The existing payment-finality certifier passes 21 adversarial cases.

## Independent FIN-6 Source Verifier

A dedicated static FIN-6 verifier was added: `scripts/verify-fin6-accounting-finality-matrix.mjs`.

It binds 32 accounting/finality source invariants covering settlement schema/accounting, DB-finality receipt barrier, settlement receipt/accounting contract, refund accounting uniqueness/durable evidence, and the canonical payment finality predicate.

Result:
`FIN6_ACCOUNTING_FINALITY_MATRIX=PASS source_invariants=32 runtime_financial_delta=ZERO`

The verifier is integrated into `scripts/run-financial-recovery-build-verifier.mjs`. The complete financial recovery verifier chain passes through FIN-6.

## Mutation / Runtime Statement

FIN-6 required no financial-runtime correction. Runtime financial delta: ZERO.

No Pi payment creation, Pi completion mutation, Horizon submission, refund creation, settlement creation, or production DB write was introduced by FIN-6 certification. The live reconciliation work was evidence-only/read-only.

## Final Closure

FIN-6 = FULL PASS / CLOSED

Accounting, settlement finality, refund finality, receipt truth, PostgreSQL durable evidence, Pi Platform evidence and Horizon movement truth reconcile with no unexplained final financial movement and no proven financial defect requiring a runtime patch.

Next planned phase: FIN-7 — Crash Windows Sweep.
