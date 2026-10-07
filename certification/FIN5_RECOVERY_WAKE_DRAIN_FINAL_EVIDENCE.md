# FIN-5 — Recovery Wake & Drain / Fresh Dispatch Pre-Create Guard — Final Evidence

**Certification date:** 2026-10-07  
**Network:** Pi Testnet  
**Production deployment:** `dpl_A1PUmf1b5UnzHQsGHD5tXhnboNqa`  
**Production Git SHA:** `84dc7bee4fc2ca585082747fbec3ab7f957fd5ed`  
**Final result:** **FULL PASS / CLOSED**

## 1. Certification objective

FIN-5 certifies that FlashPay recovery can rediscover durable work, wake and drain it safely, and continue a valid payment to merchant finality without treating Redis as financial truth, without crossing Settlement/Refund authority, and without authorizing a duplicate merchant A2U create after an ambiguous interruption.

The governing financial rules remained unchanged throughout FIN-5: PostgreSQL durable evidence plus verified Pi/Horizon are financial truth; Redis is coordination/projection only; `customerAmount === merchantAmount`; `appCommission = 0`; Horizon fee is separate; Settlement XOR Refund; uncertainty fails closed.

## 2. Architecture and rediscovery proof

Source inspection established that pre-A2U recovery is PostgreSQL-driven. Durable `payment_identity` evidence can reconstruct a missing Redis projection only after exact durable identity and Pi authority checks. The wake path does not itself invent merchant-movement authority. Refund/settlement exclusion is checked before scheduling financial continuation.

The production recovery endpoint is `/api/recovery/transient`. It is protected by the configured recovery authority / Vercel Cron authority, uses a drain lease to prevent overlapping drains, and is also awakened by the external production wake source. Live production logs proved the endpoint executed on the current deployment and processed recovery work.

## 3. Defect discovered during FIN-5

The explicit `SETTLEMENT_CREATE` path already had a pre-create exactly-once authority gate. Inspection of the fresh recovery `SETTLEMENT_DISPATCH` path found a real proof gap: after durable merchant authority was established, Stage 1 could reach Pi A2U creation without an equivalent durable one-shot pre-create claim.

That meant a crash or ambiguous interruption around the first Pi A2U create could leave insufficient durable evidence to prove that a second create was forbidden. This was a safety defect even though no duplicate movement had been observed.

**Finding:** `FIN5_FRESH_DISPATCH_PRECREATE_GATE = DEFECT`.

## 4. Repair

The repair introduced a PostgreSQL-backed create generation and one-shot attempt claim while preserving all existing financial invariants.

New settlement payment identities created by the repaired code are born with:

- `a2u_create_guard_version = 'fin5_v1'`
- `a2u_create_attempted_at = NULL`

Before the first Pi A2U create, `claimSettlementA2UCreateAttempt(...)` must atomically succeed. The claim:

- acquires the PostgreSQL payment advisory transaction lock;
- excludes durable Refund authority;
- requires the exact payment, merchant, amount, U2A identifier, U2A txid and payer identity;
- requires completed verified U2A authority;
- requires the settlement to remain pristine with no A2U/prepared/Horizon/Pi/finality movement evidence;
- requires `a2u_create_guard_version = 'fin5_v1'`;
- requires `a2u_create_attempted_at IS NULL`;
- writes `a2u_create_attempted_at = NOW()` before Pi A2U create.

A second claim cannot re-authorize create. If the process crashes after the claim, recovery must reconcile/fail closed rather than create again. Legacy rows that cannot prove the `fin5_v1` pristine generation are not silently upgraded; they fail closed instead.

The dedicated build verifier proved the guard exists, the claim precedes Pi POST, Refund exclusion and PostgreSQL serialization are present, and non-`RECORDED` claim outcomes stop before Pi create.

## 5. Legacy fail-closed evidence

Legacy Candidate 1, payment `a82a250d-11ca-47d9-a722-5530d4eca740`, remained intentionally unmodified after cutover:

- `a2u_create_guard_version = NULL`
- `a2u_create_attempted_at = NULL`
- no new A2U payment/tx/prepared/Horizon/finality movement was created by the repaired guard;
- its Redis projection remained held/manual-review from the earlier ambiguity rather than being forced back into a fresh-create state.

This confirmed that the repair did not manufacture pristine authority for legacy ambiguous work.

## 6. Live production certification — Candidate 2

A new post-deployment Pi Testnet payment was executed specifically to exercise the repaired fresh `SETTLEMENT_DISPATCH` path.

**FlashPay payment:** `c5f9b943-c6ff-4085-98dd-95570bf4da3f`  
**Customer amount:** `0.20 Pi`  
**Merchant amount:** `0.20 Pi`  
**Merchant:** `Collomak`  
**A2U Pi payment:** `JrriXPvDn05VW1yCgWObv556eNCK`  
**Horizon/A2U txid:** `9f0a2d6909c2a77f4627f5b74e2736e15a5b30338dfe7e5aafa8e5a09738ab94`  
**Prepared sequence:** `97172088883773733`

### 6.1 Fresh wake and durable claim

Production recovery logs classified the new payment as fresh work and attempted settlement through the recovery drain. Before Pi create, production logged the durable one-shot claim:

`[FIN-5 A2U CREATE ATTEMPT] durable one-shot claim recorded`

PostgreSQL later proved the exact durable timestamp:

`a2u_create_attempted_at = 2026-10-07T05:28:44.349Z`

and the exact generation:

`a2u_create_guard_version = fin5_v1`

Therefore the repaired guard was not merely source-tested; it was exercised on the live production recovery path before the real A2U create.

### 6.2 Prepared and Horizon evidence

The same payment then durably recorded the prepared identity:

- prepared hash: `9f0a2d6909c2a77f4627f5b74e2736e15a5b30338dfe7e5aafa8e5a09738ab94`
- prepared sequence: `97172088883773733`

Horizon submission succeeded for that exact hash/txid. PostgreSQL final evidence records:

`horizon_confirmed_at = 2026-10-07T05:29:07.381Z`

The Horizon fee remained separate from the merchant amount.

### 6.3 Pi completion and interruption-safe continuation

Pi completion was durably recorded:

`pi_completed_at = 2026-10-07T05:29:09.212Z`

The first wake then released the Pi A2U slot with DB reconciliation deferred. On the following recovery pass, the executor observed that the txid already existed and explicitly skipped signing/submission rather than creating or submitting another movement. Durable Pi resume returned `REPLAYED` for the same A2U identity and txid.

This is the live interruption/continuation proof: recovery reused the already-established financial identity instead of authorizing a second A2U.

### 6.4 Atomic DB reconciliation and finality

The following recovery pass entered Stage 4 with the same canonical U2A/A2U/txid identity. Production logged:

- DB reconciliation succeeded;
- all canonical identifiers matched;
- transaction ID `6c25e99c-de75-4434-9e63-83c5373ebdb9`.

A read-only PostgreSQL query then returned the final durable checkpoint:

- `stage = db_finalized`
- `version = 9`
- `a2u_payment_id = JrriXPvDn05VW1yCgWObv556eNCK`
- `a2u_txid = 9f0a2d6909c2a77f4627f5b74e2736e15a5b30338dfe7e5aafa8e5a09738ab94`
- `prepared_tx_hash = 9f0a2d6909c2a77f4627f5b74e2736e15a5b30338dfe7e5aafa8e5a09738ab94`
- `prepared_sequence = 97172088883773733`
- `horizon_confirmed_at = 2026-10-07T05:29:07.381Z`
- `pi_completed_at = 2026-10-07T05:29:09.212Z`
- `db_finalized_at = 2026-10-07T05:29:24.078Z`
- `a2u_create_guard_version = fin5_v1`
- `a2u_create_attempted_at = 2026-10-07T05:28:44.349Z`
- `certification_hold = NULL`
- `updated_at = 2026-10-07T05:29:24.078Z`

The public payment read subsequently returned `settled_to_merchant`.

## 7. Exactly-once / XOR observations

For the live Candidate 2 evidence window:

- one guarded A2U identity was observed;
- one Horizon txid was used through prepared, Horizon, Pi completion and DB finality;
- the continuation pass skipped signing because the txid already existed;
- no second A2U identity or second txid was observed after finalization;
- no certification hold was present at finality;
- no conflicting Refund authority was used for this settlement.

This closes the FIN-5 proof gap without claiming more than the evidence shows: the live test proves the repaired fresh recovery path, durable one-shot pre-create authorization, interruption-safe continuation, and final durable settlement for this certified production execution.

## 8. Final FIN-5 verdict

- `FIN5_WAKE_EXECUTION = PASS`
- `FIN5_DURABLE_REDISCOVERY = PASS`
- `FIN5_U2A_PI_HORIZON_AUTHORITY = PASS`
- `FIN5_NEW_IDENTITY_GUARD_BIRTH = PASS`
- `FIN5_DURABLE_ONE_SHOT_PRECREATE_CLAIM = PASS`
- `FIN5_REFUND_EXCLUSION_AT_CLAIM = PASS`
- `FIN5_LEGACY_ROWS_FAIL_CLOSED = PASS`
- `FIN5_FRESH_DISPATCH_GUARD_LIVE_EXERCISED = PASS`
- `FIN5_PREPARED_EVIDENCE = PASS`
- `FIN5_HORIZON_CONFIRMATION = PASS`
- `FIN5_PI_COMPLETION = PASS`
- `FIN5_INTERRUPTION_SAFE_RESUME = PASS`
- `FIN5_DB_FINALITY = PASS`
- `FIN5_LIVE_WAKE_DRAIN = PASS`
- `FIN5_DUPLICATE_A2U_OBSERVED = 0`
- `FIN5_CERTIFICATION_HOLD_AT_FINALITY = 0`

# FIN-5 = FULL PASS / CLOSED

Next planned certification stage: **FIN-6 — Accounting / Finality Matrix**.

## 9. Artifact isolation statement

This file is certification evidence only. It is stored under `certification/`, is not imported by application runtime code, does not alter package scripts or dependencies, and contains no executable production logic or secrets. Its presence must not be interpreted as runtime financial authority; the live PostgreSQL/Pi/Horizon evidence described above remains the authority for the certified event.
