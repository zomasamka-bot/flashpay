# FIN-1 — Baseline / Reconciliation Lock — Final Evidence

Status: **FULL PASS / CLOSED**  
Evidence class: historical read-only production reconciliation + current durable source/build bindings  
Normalization date: 2026-10-08  
Runtime change in this normalization: **NONE**

## Objective

Establish a trustworthy financial baseline before later FIN work: PostgreSQL durable records must reconcile to canonical Horizon movement evidence, reverse Horizon movement must be explainable by current durable records or preserved historical receipts, and the release baseline must not contain unexplained settlement/refund overlap, duplicate finality, amount/commission drift, or an unaccounted outbound movement.

## Original proof gap

The FIN-1 closure existed as distributed release/reconciliation evidence rather than a single reviewer-facing `FIN1_*_FINAL_EVIDENCE.md` file. The gap being normalized here is evidence packaging, not an open financial-runtime defect.

## Historical closure evidence

The certified FIN-1 read-only reconciliation run established:

- PostgreSQL inspection was read-only.
- Forward DB -> Horizon reconciliation matched **90/90** finalized settlement/refund movements.
- Reverse outbound Horizon scan classified **153** movements as **90 current durable movements + 63 historical receipt-backed movements**.
- Unexplained reverse movements: **0**.
- Settlement/refund overlap: **0**.
- The merchant-balance reconciliation at the release baseline matched **29/29** merchant balances; canonical stored settled value was **91.62000000**, with unsettled overlap **0** and duplicate movement **0**.

These values are historical certification facts. This normalization does not claim that they were re-run on 2026-10-08 and does not mutate production to reproduce them.

## Current durable/source authority

The current source package preserves the same financial authority model:

- PostgreSQL durable evidence is financial truth together with canonical Pi/Horizon evidence.
- Redis remains coordination/projection authority only, not financial truth.
- `certification/FIN6_ACCOUNTING_FINALITY_MATRIX_FINAL_EVIDENCE.md` independently preserves forward DB -> Horizon and reverse Horizon -> ledger/Pi reconciliation semantics and closes unexplained movement/accounting/finality classes at zero.
- `certification/SETTLEMENT_REFUND_XOR_EVIDENCE.json` and the production-bound XOR certifier preserve Settlement XOR Refund.
- `certification/WALLET_SUBMIT_BOUNDARY_EVIDENCE.json` preserves prepared/authorization/intent and post-submit reconciliation boundaries.
- The mandatory build verifier executes the financial invariants, payment-finality, crash-policy, XOR, wallet-submit-boundary, Redis-CAS, and production-callgraph gates.

## Financial invariants protected

- `customerAmount === merchantAmount`
- `appCommission = 0`
- Horizon fee is separate
- Settlement XOR Refund
- canonical movement/finality is never inferred from Redis
- no unexplained Horizon movement is accepted as finalized truth
- no invented finality and no blind retry

## Exact closure predicate

FIN-1 is closed when the release baseline has a read-only forward and reverse financial reconciliation with zero unexplained movement/overlap/duplicate discrepancy, and later source/build gates continue to enforce the same authority and invariants without contradictory evidence.

Historical FIN-1 satisfied that predicate. Current FIN-6 and mandatory production-source-bound gates provide non-contradictory durable continuity. No new evidence in the 2026-10-08 baseline reopens the predicate.

## Limitations

This file normalizes previously certified evidence. It does **not** represent a fresh 2026-10-08 production DB/Horizon scan, and no such scan is required merely to repair reviewer packaging. A new contradictory movement, ledger discrepancy, or canonical-evidence failure would reopen the relevant predicate.

## Final result

**FIN-1 = FULL PASS / CLOSED.**  
**Normalization classification: DOCUMENTATION / EVIDENCE ONLY — ZERO FINANCIAL RUNTIME CHANGE.**
