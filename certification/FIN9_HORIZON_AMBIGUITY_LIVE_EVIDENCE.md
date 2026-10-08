# FIN-9 — Horizon Submit Ambiguity LIVE — FULL PASS / CLOSED

Date: 2026-10-08  
Scope: one exact 0.30 Pi Testnet production fixture. The FIN-9 live-only trigger is removed after certification; DR11 0.10 refund certification remains unchanged.

## What was proved
FlashPay durably stored the signed settlement XDR, transaction hash, and sequence before Horizon submit. The controlled LIVE boundary simulated loss of the successful Horizon submit response. The existing ambiguity path reconciled canonical Horizon truth by the same prepared identity instead of rebuilding/re-signing or blindly submitting a new transaction.

Fixture: `3624ea8b-2cf5-482f-8f1c-e31b316d8cba`  
Prepared/final A2U hash: `3c220cce2540b2ce26b92db1c6dee821e81f868a8aac244f8af868c614f57d2b`  
Prepared/Horizon sequence: `97172088883773736`

## Evidence
- PostgreSQL: `db_finalized`; customer `0.30000000`; merchant `0.30000000`; commission `0.00000000`; prepared XDR present; prepared hash = A2U txid; no certification hold.
- Canonical Pi Testnet Horizon: successful; ledger `27058317`; sequence `97172088883773736`; fee `100000` stroops; operation count `1`.
- Duplicate proof: one fixture checkpoint, one prepared hash, one prepared sequence, one A2U txid; same hash/txid occurs once globally; refund overlap `0`.
- Post-test verifier: `FIN6_ACCOUNTING_FINALITY_MATRIX=PASS source_invariants=32 runtime_financial_delta=ZERO`.

All FIN-9 closure predicates passed: durable prepared identity before submit, real Horizon acceptance, controlled response loss, exact canonical reconciliation, no second identity/new sequence/re-sign/duplicate movement, exact fee/movement durability, deterministic Pi/DB finality, and settlement/refund XOR preserved.

**FIN-9 = FULL PASS / CLOSED.**

Release hygiene: `FLASHPAY_FIN9_LIVE_PAYMENT_ID` was removed from Vercel Production and the disarmed deployment was verified READY. The temporary FIN-9 live hook/helper/verifier are removed from this source release; this compact permanent evidence remains.
