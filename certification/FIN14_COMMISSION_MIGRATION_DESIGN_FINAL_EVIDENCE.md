# FIN-14 — Commission Migration Design — FINAL EVIDENCE

Status: DESIGN-ONLY PASS / NO ENABLE / NO RUNTIME PATCH
Baseline: FIN-13 certified clean artifact, 2026-10-08.

## Non-negotiable production lock
FIN-14 does not enable commission and does not relax current production invariants. Until a separate future migration release passes every gate below:
- `merchantAmount === customerAmount`
- `appCommission === 0`
- Horizon fee remains separate execution cost
- Settlement XOR Refund remains mandatory
- Pi Testnet-only ingress remains unchanged
- current schema/runtime checks remain in force

## Immutable payment fee contract
A future fee-bearing payment MUST acquire one immutable durable contract at payment creation, before any financial mutation/replay authority is created. Required fields:
- `feePolicyVersion` — immutable policy identifier; never inferred from current configuration during replay.
- `feeContractVersion` — immutable schema/semantics version for the contract itself.
- `customerGross` — exact amount authorized/paid by customer.
- `merchantNet` — exact amount contractually owed/transferred to merchant.
- `appCommission` — exact commission fixed at creation.
- `currency` and `network` — immutable identity dimensions.
- `commissionBasis` — versioned basis used to derive commission.
- `roundingMode` and `amountScale` — versioned deterministic rounding semantics.
- `createdAt` plus immutable payment identity binding.

Contract invariant for a future commission policy:
`customerGross = merchantNet + appCommission`.
Horizon execution fee is NOT part of this equality and MUST NOT mutate any of its three values.

## Horizon fee semantics
`horizonFeeCharged` is actual execution evidence recorded after the relevant Horizon transaction. It is separate from the commercial fee contract. A higher/lower Horizon fee MUST NOT retroactively change customerGross, merchantNet, appCommission, feePolicyVersion, or refund entitlement.

## Legacy isolation
Every pre-migration zero-fee payment is classified explicitly as `LEGACY_ZERO_V0` during migration/backfill. Its immutable semantics are:
- customerGross = legacy customer amount
- merchantNet = customerGross
- appCommission = 0
- no fee-bearing policy may be inferred from NULL/missing fields

NULL/unknown/unrecognized/corrupt fee contract state MUST fail closed. It MUST NEVER fall back to the currently active policy.

## Settlement rule
Settlement consumes only the payment's immutable stored fee contract. It MUST NOT query the current policy to recompute merchantNet or appCommission. Durable prepared XDR/hash/sequence and Horizon proof remain authoritative movement evidence. Receipt/accounting/finality must persist and exactly revalidate the same contract values.

## Refund rule
Refund entitlement is bound to the original immutable payment contract and original customer gross. A later policy change cannot change refund amount. A refund MUST NOT substitute merchantNet for customerGross and MUST NOT recompute commission from the current policy. Settlement XOR Refund and all existing opposite-authority barriers remain mandatory.

## Accounting rule
Future accounting must keep at least four independently auditable values: customerGross, merchantNet, appCommission, and actual Horizon fee. Merchant balances credit merchantNet only. Commission accounting credits exactly the immutable appCommission only after the policy-defined finality barrier. Horizon fee remains separately attributable execution cost. Replay may reproduce accounting only from the stored immutable contract and canonical movement evidence.

## Replay / recovery rule
All retries, crash recovery, reconciliation and historical reads use the contract frozen on that payment. Current/global policy is forbidden as a replay input. A contract mismatch is CONFLICT/fail-closed, never a recalculation opportunity.

## Rounding rule
No binary floating-point recomputation is authoritative for migration accounting. Future implementation must use a deterministic fixed-scale decimal/integer representation and the roundingMode/amountScale frozen in the contract. Rounding occurs exactly at the versioned policy boundary; replay compares stored results rather than reinterpreting old values under new rules.

## Migration gates — all required before any enablement
1. Additive schema only; do not remove zero-fee constraints yet.
2. Backfill every legacy payment/receipt/checkpoint into explicit `LEGACY_ZERO_V0` semantics without changing financial values.
3. Prove 100% legacy classification; zero NULL/unknown contracts on any financial row eligible for replay/finality/refund.
4. Prove immutable payment↔contract one-to-one binding and uniqueness.
5. Prove settlement, receipt, merchant balance, finality checkpoint, refund checkpoint and refund accounting all consume the stored contract rather than current policy.
6. Prove exact decimal/rounding behavior at boundary and adversarial edge amounts.
7. Prove legacy replay/refund after a new policy is activated still produces zero commission and original amounts.
8. Prove new-policy replay/refund after policy rotation still uses its original version and amounts.
9. Prove mixed concurrent legacy/new-policy traffic cannot cross-bind contracts or identities.
10. Prove Redis loss cannot lose/change fee contract; PostgreSQL durable evidence remains authority.
11. Prove Settlement XOR Refund, no-blind-retry, single-wallet sequence and prepared-XDR evidence unchanged.
12. Full forward/reverse accounting reconciliation: customer gross, merchant net, commission, Horizon fee, merchant balances, refunds; unexplained delta=0.
13. Dedicated live Testnet certification for each enabled fee policy version.
14. Explicit rollback/disable gate that stops NEW fee-bearing payment creation without mutating contracts of existing payments.
15. Only after gates 1–14 pass may a separate release deliberately relax the current zero-fee schema/runtime checks.

## Forbidden migration shortcuts
- reading `CURRENT_FEE_POLICY` during settlement/refund/replay for an existing payment
- treating NULL policy as the newest policy
- deriving commission from Horizon fee
- mutating an existing payment's feePolicyVersion or monetary contract
- backfilling legacy rows with non-zero commission
- recomputing historical money with a newer rounding rule
- enabling commission by environment variable alone
- dropping current zero-fee CHECKs before complete backfill/certification
- using Redis as fee-contract authority

## FIN-14 closure
This stage is architecture/design certification only. No commission is enabled. No application/runtime/schema/dependency surface is changed by FIN-14. A future commission implementation is a new gated migration/release and must satisfy this contract before activation.
