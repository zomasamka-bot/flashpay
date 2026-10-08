# FIN-3 — Same-Wallet Runtime Collision Proof — Final Evidence

Status: **FULL PASS / CLOSED**  
Evidence class: production-source binding + deterministic cross-instance contention model + mutation sensitivity  
Normalization date: 2026-10-08  
Runtime change in this normalization: **NONE**

## Objective

Prove that two independent execution instances cannot concurrently cross the Horizon submit boundary from the same source wallet, while preserving safe progress after legitimate release and preventing a stale owner token from releasing a successor's lock.

## Original proof gap

The reviewer required explicit same-source-wallet cross-instance collision evidence rather than relying only on architectural intent. The proof needed to bind both Settlement and Refund submission paths to the source-wallet exclusion boundary.

## Source/runtime authority

`lib/pi-wallet-submit-lock.ts` binds the submit lease to:

- key `flashpay:wallet:submit:${sourceAddress}`;
- Redis `SET NX EX 600` acquisition;
- token-checked renewal;
- token-checked release;
- source-wallet-scoped persistent wallet intent.

Redis is not treated as financial truth. Durable wallet intent, prepared/authorization evidence, and exact Horizon reconciliation remain required movement authorities.

## Settlement / Refund production bindings

The P7 certifier binds current production source so that:

- Settlement Stage2 acquires the source-wallet intent submit lock before the prepared Horizon movement crosses submit and holds exclusion through the durable Horizon checkpoint.
- Fresh Refund acquires the source-wallet intent submit lock before its one-shot blockchain submit and releases only afterward.
- Prepared Refund replay reacquires source-wallet exclusion and rereads exact durable recovery evidence under the lock.
- Settlement recovery also binds to the source-wallet submit lock before any eligible replay/reconciliation boundary.

## Cross-instance collision proof

`certification/PLAN_I_P7_SAME_WALLET_CROSS_INSTANCE_CONCURRENCY_EVIDENCE.json` and `scripts/verify-plan-i-p7-same-wallet-cross-instance-concurrency.ts` preserve the deterministic two-instance barrier proof:

- two independent instances;
- same source wallet;
- distinct payment IDs;
- first owner acquires;
- second owner is excluded while the first owns the wallet;
- `max_in_flight = 1`;
- stale token cannot release the active owner;
- second owner progresses after legitimate release;
- maximum in-flight submitters remains one in the second round.

## Mutation sensitivity

The certifier requires expected failure for six safety regressions:

1. remove `NX`;
2. key lock by payment instead of source wallet;
3. remove release token check;
4. remove renewal token check;
5. bypass Settlement wallet lock;
6. bypass Refund wallet lock.

Unexpected mutation passes recorded by the preserved evidence: **0**.

## Relevant build gates

- `verify-plan-i-p7-same-wallet-cross-instance-concurrency.ts`
- `verify-wallet-submit-boundary-production-binding.ts`
- crash-policy and exact post-submit reconciliation gates in the mandatory financial verifier

The preserved P7 evidence explicitly records `runtime_files_changed: []` and `full_financial_verifier: PASS` for the certification-only closure.

## Financial invariants protected

- single-wallet sequence discipline
- shared exclusion at the submit boundary
- exact prepared identity / authorization before eligible movement
- no blind retry after ambiguous submit
- canonical Horizon reconciliation
- Redis coordination is not finality

## Exact closure predicate

FIN-3 is closed when current production source binds Settlement and Refund submit paths to the same source-wallet exclusion discipline, a two-instance contention proof demonstrates `max_in_flight = 1`, stale-owner release is impossible in the model, and mutation sensitivity rejects bypass/key/token regressions.

The current 2026-10-08 baseline satisfies that predicate through the preserved P7 and wallet-submit-boundary certifiers. No contradictory evidence is present.

## Limitations

The deterministic certifier proves the production-source concurrency contract and collision semantics; it does not claim Redis itself is durable financial truth. Loss/ambiguity outside the lease is contained by durable intent/prepared evidence and exact canonical reconciliation, which are certified separately.

## Final result

**FIN-3 = FULL PASS / CLOSED.**  
**Normalization classification: DOCUMENTATION / EVIDENCE ONLY — ZERO FINANCIAL RUNTIME CHANGE.**
