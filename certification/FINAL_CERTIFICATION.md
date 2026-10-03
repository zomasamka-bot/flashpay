# FlashPay — Compact Final Certification Evidence

Certification date: 2026-10-03
Scope: reviewer-visible, non-runtime evidence for the frozen release candidate.

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
- Crash policy: PASS (26 crash windows)
- Settlement XOR Refund: enforced by durable authority/exclusion checks
- Stored XDR: evidence only; Horizon movement: financial truth
- Unknown/indeterminate authority: fail closed; no blind financial retry

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
| Upstash Redis REST PING | 100 | 0.540s | 0.747s | 3.461s | 75.591s | 0 observed | End-to-end REST PING; one large tail-latency outlier retained in evidence |
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
