# FIN-2 — Review / Dashboard Freshness Closure — Final Evidence

Status: **FULL PASS / CLOSED**  
Evidence class: production-source binding + mutation-sensitive certifier + preserved release evidence  
Normalization date: 2026-10-08  
Runtime change in this normalization: **NONE**

## Objective

Ensure an already-open merchant review/payments surface does not remain presentation-stale after backend state changes, without changing financial truth, settlement/refund execution, or durable finality semantics.

## Original proof gap

The reviewer identified a non-financial presentation freshness gap. The merchant payments page could require a manual refresh to surface newer read-only server truth promptly. This was not a financial-ledger defect.

## Implemented closure

The existing closure adds presentation-only refresh behavior:

- refresh every **20 seconds** while the document is visible;
- refresh immediately when visibility returns to `visible`;
- continue using the existing read-only merchant payments API;
- background refresh does not blank the already-loaded dashboard.

The implementation is present in `app/merchant/payments/page.tsx`.

## Durable evidence and certifiers

- `certification/PLAN_I_P2_P4_REVIEW_CLOSURE_EVIDENCE.json` classifies P2 as `CONFIRMED_NON_FINANCIAL_PRESENTATION_FRESHNESS_GAP_FIXED` and records `financial_semantics_changed: false`.
- `scripts/verify-plan-i-p2-p4-review-closure.ts` is wired into `scripts/run-financial-recovery-build-verifier.mjs`.
- The certifier binds the 20-second visible-tab refresh and visibility-return refresh to current production source.
- Mutation sensitivity covers removal of dashboard polling and removal of visibility refresh; both are required to fail certification.
- The same evidence package records zero new dependencies and preservation of the Byte Studio compatibility contract.

## Source/runtime authority

The dashboard is a read-only presentation consumer. PostgreSQL/Pi/Horizon durable financial authorities remain unchanged. No dashboard timer or visibility event is permitted to create settlement, refund, Pi completion, or Horizon movement authority.

## Financial invariants protected

All financial invariants remain unchanged, including Settlement XOR Refund, zero commission, canonical movement proof, no blind retry, and no Redis financial authority.

## Exact closure predicate

FIN-2 is closed when current production source contains both bounded visible-tab refresh and immediate visibility-return refresh against the existing read-only payments API, the mutation-sensitive build certifier enforces both bindings, and no financial execution semantics are changed.

The current 2026-10-08 baseline satisfies that predicate.

## Limitations

This closure guarantees source-bound presentation refresh behavior; it does not claim that every external network request completes within 20 seconds. External latency/failure remains distinct from financial finality.

## Final result

**FIN-2 = FULL PASS / CLOSED.**  
**Normalization classification: DOCUMENTATION / EVIDENCE ONLY — ZERO FINANCIAL RUNTIME CHANGE.**
