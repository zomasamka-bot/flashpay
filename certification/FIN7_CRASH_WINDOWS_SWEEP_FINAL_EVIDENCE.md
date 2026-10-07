# FIN-7 Crash Windows Sweep — Final Evidence

Date: 2026-10-07
Baseline production SHA: `c1bf96ff8f1f97d833ee2acb775558cbea6cbbce`
Scope: taxonomy/certifier closure only. No Pi/Horizon/Settlement/Refund execution kernel change.

## Decision

The historical 26-window model is superseded by a 41-window canonical model bound to the current FIN5 + FIN7-S1/S2/S3/S4 runtime. The expansion is a certification correction, not evidence of 15 additional runtime defects. S1-S4 already closed the runtime authority defects that exposed the missing boundaries.

FIN-7.5 read-only durable-state proof is CLOSED/FULL PASS. No unique unresolved FIN-7 live proof gap remains after current-source binding; therefore FIN-7.6 live crash injection is NOT REQUIRED. Approve/Complete ambiguity LIVE remains FIN-8 scope and Horizon ambiguity LIVE remains FIN-9 scope.

## Governing safety semantics

- PostgreSQL durable evidence plus verified Pi/Horizon evidence is financial truth.
- Redis is coordination/projection only and cannot authorize financial movement.
- One-shot durable attempt claims have `retryAuthority=NEVER`; `CONFIRMED_NONE` does not reopen a consumed attempt.
- Pre-attempt boundaries may use `CONFIRMED_NONE` only where the runtime still has a fresh one-shot claim available.
- Money-moved windows reconcile against Horizon and never repeat movement.
- Uncertainty/conflict => MANUAL_REVIEW / fail closed.
- Settlement XOR Refund remains unchanged.

## Canonical count

`FINANCIAL_RECOVERY_CRASH_WINDOWS.length === 41`, unique by construction. `FinancialRecoveryCrashWindow` is derived from that runtime constant so the type and certifier cannot silently drift into separate lists.

### New/modernized boundaries

1. U2A approval ownership before attempt claim.
2. Approval attempt claimed before Pi approve.
3. Pi approved before exact approval reconciliation.
4. Durable U2A verified before completion attempt.
5. U2A completion attempt claimed before Pi complete.
6. Pi U2A complete before durable PG completion.
7. Durable PG U2A completion before Redis projection.
8. U2A cancel attempt before Pi cancel.
9. Pi cancelled before durable retirement.
10. Settlement A2U create attempt claimed before Pi create (FIN5).
11. Redis prepared before durable PG prepared authority (FIN7-S1).
12. Durable prepared checkpoint before Horizon submit (modernized historical window).
13. Settlement A2U completion attempt before Pi complete.
14. Refund create attempt claimed before Pi create (FIN7-S4).
15. Refund completion attempt before Pi complete.
16. DR11 orphan A2U cancel attempt before Pi cancel.
17. DR11 Pi cancellation before refund containment.

The net canonical increase is 26 -> 41 because one obsolete U2A Pi-complete-to-Redis window is split into two current durable boundaries while other historical windows are retained or renamed rather than duplicated.

## Explicit dedup decisions

No duplicate window was added for:
- settlement Pi create success before durable A2U identity: historical create-returned-before-ID already covers it;
- settlement Pi complete success before completion checkpoint: historical semantic boundary retained;
- refund Pi create success before refund payment-ID checkpoint: historical semantic boundary retained;
- refund Pi complete success before payment projection: historical semantic boundary retained;
- primary and transient U2A complete routes: two code surfaces share the same durable mutation kind and therefore one canonical financial crash state.

## Certifiers

- `verify-financial-recovery-crash-policy.ts`: exact 41 coverage, uniqueness, fail-closed semantics, retry authority.
- `verify-plan-h-crash-policy-production-binding.ts`: historical production-binding checks retained; stale 26 assertion updated to 41.
- `verify-fin7-crash-windows-current-source.mjs`: source-binds FIN5/S1/S2/S3/S4 ordering and one-shot authority to the current runtime.
- Main financial recovery build verifier imports the new FIN-7 certifier.

## Runtime kernel exclusion

This closure intentionally does not modify Pi POST code, Horizon submit code, settlement/refund executors, database mutation functions, wallet locks, accounting, finality, commission, network mode, dependencies, or UI.

## Closure predicate

FIN-7.8 may PASS only when the complete financial recovery verifier and production build pass on this artifact and release hygiene proves the exact intended certification-only diff. FIN-7 itself remains OPEN until FIN-7.9 clean artifact SHA and production Git/Vercel binding are complete.
