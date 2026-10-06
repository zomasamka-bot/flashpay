# FIN-4 — Cross-Instance Source-Wallet Serialization Evidence

**Run:** FIN4-20261005-1643-D50D  
**Scope:** Pi Testnet / FlashPay production source wallet `GCVYA2KC6ANJOW4OMOSUKFLSBMZDYQWZ4S6HA654MIWHG6NZC4ZZOVD5`.

## Reviewer proof gap closed
The open question was whether concurrent Vercel invocations spending from the same FlashPay source wallet could enter the Horizon-submit critical section together, collide on sequence, duplicate movement, or corrupt durable financial state.

A live cross-instance probe used the exact production wallet-submit lock. One holder acquired the lock and eight concurrent contenders attempted the same wallet boundary. All eight were blocked while the holder retained ownership; six distinct Vercel processes were observed and `distinctInstanceProven=true`. The probe itself executed no Pi mutation, Horizon submit, financial movement, or financial-authority mutation.

This proves **wallet-level cross-instance serialization** at the production submit boundary. It does not claim that twenty real financial payments were submitted concurrently.

## Independent movement and recovery evidence
A reverse, read-only Horizon scan for the relevant pre-recovery window found `matchCount=0`, excluding a hidden FIN-4 movement in that window. After FIN-4 guards were removed, payment B recovered naturally through the production wallet boundary and settled exactly once. Its canonical Horizon transaction is `91b09b990184fa73bd8c893a2b514a1d4576be42ae933140511df25b9e682c87`; replay observed the same transaction and did not resubmit Stage 2.

Incidental defects exposed during certification were closed fail-closed: foreign ongoing Pi A2U identity rejection (R4R), its failure classification (R4S), and automatic-refund retirement containment (R4T4). Durable lifecycle cleanup remains append-only/auditable through the R4J/R4P/R4T retirement mechanisms.

## Final reconciliation
On 2026-10-06, Step 13 returned `DB_PI_HORIZON_RECONCILED` from live read-only PostgreSQL + Pi GET + Horizon GET evidence:

- A: `PRESERVE_NO_ACTION`; no A2U movement; poisoned automatic refund retired; no refund movement.
- B: `NATURALLY_SETTLED`; durable settlement, transaction, receipt, Pi U2A/A2U and Horizon movement all exact.
- C: `R4J_RETIRED`; Pi cancelled with no transaction; no settlement/refund movement.
- Duplicate financial identities: `0`.
- Refund duplicate identities: `0`.
- Merchant balance mismatches: `0`.
- Settlement/Refund overlap: `0`.
- Reconciliation mutations: `0` (no Pi mutation, Horizon submit, or financial-authority mutation).

**FIN-4 technical evidence conclusion:** the reviewer’s cross-instance same-wallet serialization proof gap is closed. Final release closure remains gated on Step 15 deployment/build/runtime verification of the cleaned artifact containing this evidence file.
