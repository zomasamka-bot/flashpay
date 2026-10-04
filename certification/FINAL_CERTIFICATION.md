# FlashPay — Compact Final Certification Evidence

Certification date: 2026-10-03
Scope: reviewer-visible, non-runtime evidence for the frozen release candidate.


## Current release override — DR11 refund race / orphan recovery / customer UI / corrected PLAN D

This artifact is a newer release than the historical PLAN 1→3 evidence sections below. Statements in those historical sections that say “runtime delta NONE” apply only to those earlier plans and **do not** describe this current DR11 repair release.

Current runtime delta is intentionally narrow:
- `/api/pi/complete`: exact production Pi Testnet `0.10` DR11 flow durably acquires Refund hold **before** publishing U2A completion eligibility, then converts that hold to Refund authority. This closes the observed Stage-1 race.
- `refund-executor`: a legacy DR11 race artifact carrying only an orphan A2U Pi identifier may recover **only** after durable U2A + PostgreSQL Refund authority are re-proven, the exact Pi A2U is proven unmoved, it is cancelled via Pi Platform API, and a post-cancel re-read proves `CANCELLED_UNMOVED`. Any txid, prepared XDR/hash/sequence, Horizon success, Pi transaction evidence, identity mismatch, or uncertainty remains blocked. Redis repair is CAS-fenced and occurs only after this proof. General Refund behavior is unchanged.
- Customer Refund UI: loading and all non-terminal Refund states show the requested red warning. Green success is shown only for `customerStatus=refund_completed`; the presentation continues polling until terminal status and exposes the final receipt fields.
- PLAN D: the rejected imaginary dependency on `./financial-recovery-settlement-submit-replay` is removed. The mandatory gate now binds the real settlement read orchestration, replay pre-gate, replay gate, Refund dynamic blockchain-submit edge, and CAS callers.

Current mandatory build-gate evidence:
- `PRODUCTION_CALLGRAPH_BINDING=PASS assertions=37`
- `DR11_REFUND_RACE_UI_BINDING=PASS order=hold_before_completed_before_refund_authority ui=red_until_terminal_green translations=7`
- `DR11_ORPHAN_A2U_RECOVERY=PASS candidate_cases=9 dto_cases=7 runtime_binding=7 fail_closed=true`
- DR11 orphan-recovery mutation suite: 4/4 expected failures, 0 unexpected passes.


## Release identity
- Input clean ZIP: FlashPay_PLAN2_DEAD_STORE_REMOVED_CLEAN_2026-10-03.zip
- Input ZIP SHA-256: 5165e6632818f700012d3290d5e53e21d334d50d05c5d925d4d81d4bfd07254a
- Certified production Git SHA before evidence-only packaging: 540c0861487609a071c30be6d01af18190909915
- Certified production deployment: dpl_8pQy65bt8gvEYG7Smz4dmPt5HvcM (READY)
- Runtime/financial code delta introduced by this evidence pack: NONE

## Financial certification
- Confirmed financial defects: 0
- Financial-kernel patch authorized: NO
- U2A proof verifier: PASS
- Refund completion barrier: PASS
- Financial invariants: PASS
- Payment finality predicate: PASS (21 adversarial cases)
- Crash policy formal/model matrix: PASS (26 modeled windows); this result is not by itself a live execution proof for all production crash boundaries
- Settlement XOR Refund: production-source-bound certifier PASS (7 adversarial authority states); PostgreSQL transaction-scoped advisory lock + opposite-authority check are build-enforced
- Pi wallet submit boundary: production-source-bound certifier PASS (5 production boundaries); token-safe lease acquisition/renew/release + wallet intent + pre-submit authorization + post-submit ambiguity reconciliation are build-enforced
- Stored XDR: evidence only; Horizon movement: financial truth
- Unknown/indeterminate authority: fail closed; no blind financial retry

## Settlement XOR Refund — production binding evidence
- Certifier: `scripts/verify-settlement-refund-xor-production-binding.ts`
- Build integration: `scripts/run-financial-recovery-build-verifier.mjs`
- Evidence class: PRODUCTION-SOURCE-BOUND + ADVERSARIAL TRUTH-TABLE. This is not represented as a live PostgreSQL concurrency benchmark.
- Production Settlement acquisition: `recordSettlementA2UCreatedCheckpoint()` takes `pg_advisory_xact_lock(hashtextextended(paymentId,0))`, reads active Refund authority, fails closed on conflict/uncertainty, then may advance to `a2u_created`.
- Production Refund acquisition: `createRefundCheckpointWithAudit()` uses `withPaymentAuthorityTransaction()`, which takes the same payment-scoped PostgreSQL transaction lock; inside that transaction it reads active Settlement authority before inserting the Refund checkpoint.
- Runtime Refund acquisition/replay additionally rechecks `readSettlementRefundAuthority()` and rejects Settlement ownership or indeterminate authority.
- Adversarial authority states: 7/7 PASS, including dual durable authority => neither branch authorized and PostgreSQL uncertainty => neither branch authorized.
- Mutation sensitivity: 5/5 intentional safety-boundary mutations caused the certifier/build verifier to fail (shared advisory lock removed; Refund opposite gate removed; Settlement opposite gate removed; dual-authority conflict removed; Refund executor authority gate weakened). Mutation copies were temporary and are not included in this artifact.
- Runtime/financial behavior changed by this plan: NO. Only certification/build-verifier files changed.

## Pi wallet single-owner / submit-boundary evidence
- Certifier: `scripts/verify-wallet-submit-boundary-production-binding.ts`; integrated into the mandatory build verifier.
- Redis submit lease: UUID token + `SET NX EX 600`; renewal and release mutate only on exact token match.
- Important qualification: the lease object itself does not expose a post-renewal `isOwner()` predicate. This certification therefore does not treat Redis lease state as financial truth.
- Fresh Refund ordering is build-enforced as durable prepared evidence -> durable blockchain-submit authorization -> exactly one Horizon `submitTransaction()`.
- Exact Refund replay requires matching wallet intent + existing durable submit authorization before exactly one stored-XDR submit.
- Refund submit ambiguity is build-enforced to reconcile exact prepared/Horizon evidence; the catch branch contains no blockchain submit.
- Settlement Stage2 is build-enforced as wallet-intent submit lock -> prepare under held lock -> one low-level Horizon submit. Submit exceptions invoke exact recovery reconciliation; anything short of `MOVEMENT_VERIFIED` remains `settlement_pending`.
- Mutation sensitivity: 3/3 targeted boundary mutations produced expected build-verifier failures: fresh Refund authorization removed; fresh Refund ambiguity reconciliation removed; Settlement ambiguity reconciliation removed. Unexpected mutation passes: 0.
- Runtime/financial behavior changed by PLAN B: NO. Only certification/build-verifier files changed.

## Scale / recovery evidence
- 100 / 1,000 / 10,000 structural bounded-capacity model: PASS
- 10,000 model: 13 ready windows; 13 active windows; 50 modeled MGET batches
- Bounded recovery pipeline concurrency: 2
- Same-wallet financial movement parallelism: 1
- Duplicate selections: 0; lost selections: 0
- Historical DR17 live financial certification: 10,000 total = 5,000 settlements + 5,000 refunds; overlap 0; badMovement 0; movement_one 10,000; unrecovered 0. This is historical certification evidence, not reconstructed by the current artifact.

## 2026-10-03 physical dependency latency sampling
All samples were read-only/non-financial. No payment, settlement, refund, or financial mutation was executed.

| Dependency | N | p50 | p95 | p99 | max | failures | Measurement boundary |
|---|---:|---:|---:|---:|---:|---:|---|
| PostgreSQL / Neon pooled | 100 | 1.050s | 1.180s | 1.310s | 1.520s | 0 observed | New `psql` process/connection per sample; includes process + connect/TLS + `SELECT 1` |
| Upstash Redis REST PING | 100 | 0.540s | 0.747s | 3.461s | 75.591s | not separately captured | End-to-end REST PING; loop completed; one large tail-latency outlier retained in evidence |
| Pi Server API read-only endpoint | 30 | 0.609s | 2.163s | 2.893s | 2.893s | 0 HTTP failures | `incomplete_server_payments`, read-only GET, 5s timeout during sampling |
| Stellar Horizon Testnet root | 30 | 0.935s | 1.439s | 1.502s | 1.502s | 0 HTTP failures | Read-only GET, 5s timeout during sampling |

Redis MAX=75.591s is retained as an OPERATIONAL LATENCY OUTLIER / OBSERVATION. It is not hidden and is not classified as a financial defect from the available evidence.

## PostgreSQL / Vercel capacity reconciliation
- PostgreSQL 17.11; max_connections=901; reserved=4 (measured during the capacity investigation).
- Direct DB burst evidence: 50/50 successful requests in ~9s; observed peak 61 total / 51 active connections.
- Local `max:5` experiment was rejected as the solution: observed 326 total / 318 client backends while MAX_ACTIVE=2.
- Production DATABASE_URL was isolated through the Neon pooled endpoint; compatibility checks passed.
- Post-pooler 20-way production test: 20/20 HTTP 200 in 3.348s; 0 HTTP 429; 0 HTTP 5xx; 0 curl failures; observed peak 18 total / 11 client backends / active=1 / idle-in-transaction=0.
- Temporary local connection caps were removed; original postgres constructors retained.

## Reviewer finding disposition
- DB connection/load concern: addressed by Neon pooled endpoint and production evidence; no financial patch.
- Recovery parallelism concern: bounded by design; nonfinancial pipeline concurrency=2; same-wallet financial execution remains serial.
- Accounting separation concern: cross-query canonical accounting exists; no confirmed financial defect.
- Legacy in-memory server payment store: dependency=0 proved, then file deleted atomically in PLAN 2.
- Safe bypass/rate-limit observations: informational; no confirmed financial defect.
- 100→1K→10K capacity concern: structural boundedness certified; production dependency latency measured separately above.

## Byte Studio compatibility contract
Required round trip: Clean ZIP → Vercel PASS → Byte Studio → Export → Vercel PASS.
The release preserves the Byte-reinjected canonical UI scaffold and exact dependency contract:
- cmdk 1.1.1
- embla-carousel-react 8.5.2
- input-otp 1.4.2
- react-day-picker 9.7.0
- react-resizable-panels 2.1.8
- recharts 2.15.0
- vaul 0.9.9

Expected scaffold surfaces retained: calendar.tsx, carousel.tsx, chart.tsx, command.tsx, drawer.tsx, input-otp.tsx, resizable.tsx, use-toast.ts. No dependency pruning/upgrading is authorized by this certification.

## Final classification
- Financial safety gates: PASS
- Structural capacity gates: PASS
- Physical dependency evidence gate: PASS with Redis operational tail-latency observation retained
- Confirmed financial defects: 0
- Evidence-only packaging changes financial semantics: NO

## PLAN C — Redis Projection CAS / stale-writer production binding

- Result: **PASS**. No financial runtime patch was required.
- Evidence class: production-source-bound + adversarial truth table + mutation-sensitive build enforcement.
- Canonical Payment projection CAS atomically reads the latest Redis value, binds `paymentId`, validates a non-negative safe integer `redisProjectionVersion` (legacy missing version is 0), requires the current version to equal the caller's expected version, requires the next version to be exactly `expected + 1`, writes in the same Lua evaluation, and verifies readback. A stale snapshot returns `CONFLICT`; it is not allowed to overwrite a newer projection.
- Settlement GET→merge writes use the canonical CAS. A conflict causes a bounded re-read/re-merge (`casAttempt < 4`); all non-`UPDATED` uncertainty fails closed.
- Refund financial projection writes use the canonical CAS. A conflict is not financial success merely because another writer won: the current projection must itself carry the exact expected refund identity/transaction evidence; otherwise execution blocks.
- Direct Payment reconstruction SETs outside CAS were classified and are create-only `NX`; they cannot overwrite an extant newer projection. Specialized Lua presentation/recovery mutations operate on the latest Redis value atomically and advance `redisProjectionVersion`.
- Adversarial stale-writer/version truth table: **9/9 PASS**.
- Mutation sensitivity: **4/4 expected verifier failures, 0 unexpected passes** (removed version fence; removed exact +1 rule; disabled Settlement conflict re-read/re-merge; weakened Refund exact conflict evidence).
- Redis remains a projection/coordination layer, **not financial truth**. Durable PostgreSQL authority and exact Pi/Horizon evidence continue to govern financial finality/recovery.


## Production Call-Graph / Certifier-to-Runtime Binding — 2026-10-03

Result: **PASS — evidence-contract proof gap closed; no financial runtime defect and no runtime patch.**

The certification suite now separates four evidence classes: `PRODUCTION_ENTRYPOINT`, `RUNTIME_ORCHESTRATOR`, `RUNTIME_EVIDENCE_DEPENDENCY`, and `CERTIFIER_MODEL_ONLY`. Model/evaluator tests remain useful for adversarial logic coverage but are not, by themselves, evidence of production reachability.

A mandatory production call-graph binding gate verifies 12 critical static/dynamic source bindings, including the real Settlement ingress/recovery chain, Settlement submit/replay orchestration, the Refund transient worker through `refund-executor` and dynamic `refund-blockchain-submit`, and production CAS projection bindings. Four topology mutations that deliberately detached these paths all produced expected build-verifier failures (4/4; unexpected passes 0).

Reviewer reconciliation: the concern that the earlier certificate could blur model evidence and production binding was a confirmed evidence-contract proof gap and is now fixed. The broader claim that the examined recovery implementation is an unused second money engine is not supported by the production source call graph: recovery orchestrators re-enter the shared financial executors, while pure evidence/decision modules are classified separately.

## 2026-10-04 — Emergency / stuck-payment rescue audit

Production baseline: `a637bff53eebad3efb7fb4a2125c362fc45bed4d` / `dpl_2SjsB74r6GPbZ4YcBCRD7FcUNNbK` READY.

Reviewer gap was audited against the complete operator/emergency surface. The legacy `/api/emergency/clear-stuck-payment` route is inert and fail-closed. One narrow operational proof defect was confirmed in the live Operations queue prune path: `prune_terminal` did not reject every prepared-settlement field and did not re-prove PostgreSQL transaction/receipt absence at POST time. This did not expose a direct money movement or delete financial evidence, but could suppress recovery indexing for an inconsistent case requiring reconciliation.

Narrow fix: queue prune now requires a terminal `failed/cancelled` projection with zero settlement/refund execution evidence (including prepared hash/sequence/XDR, addresses, dispatch, reconciliation and completion flags), Refund checkpoint `ABSENT`, and a fresh PostgreSQL proof of zero transaction and receipt rows. Any uncertainty blocks. `dismiss_reviewed` is disabled so unresolved financial cases cannot be hidden from the operator console. The UI only renders queue removal for a proven prune candidate.

No settlement/refund submit, wallet lock, XOR, CAS or accounting kernel was modified. Mandatory gate: `EMERGENCY_RESCUE_SAFETY=PASS adversarial=21 runtime_bindings=8 fail_closed=true`. Mutation suite: 4/4 expected failures, 0 unexpected passes.
