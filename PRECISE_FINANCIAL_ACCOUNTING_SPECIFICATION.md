# Precise Financial Accounting Specification

## Critical Requirements

All financial accounting in `/api/pi/complete` must enforce **exact, fail-closed semantics** with zero tolerance for missing data or silent fallbacks.

## Pre-DB Write Checkpoint Re-read

**MANDATORY**: Before ANY database write, the `/api/pi/complete` route MUST:

1. Re-read the authoritative checkpoint from Redis using `await redis.get(payment:${paymentId})`
2. Validate that checkpoint contains ALL required fields
3. Fail with status 500 if ANY field is missing or invalid
4. Use checkpoint values for ALL DB operations (never fallback to request values)

## Authoritative Financial Fields

Store and use EXACTLY these fields from the Redis checkpoint:

```typescript
checkpoint.customerAmount       // Verified U2A amount (from Pi canonical payment)
checkpoint.merchantAmount       // Actual Horizon transfer amount (from A2U response)
checkpoint.horizonFeeCharged    // Actual Horizon fee (from A2U submitResult.fee_charged)
checkpoint.appCommission        // App commission (default 0)
checkpoint.appNetImpact         // Calculated: customerAmount - merchantAmount - horizonFeeCharged
checkpoint.merchantId           // From Redis checkpoint (NOT from canonicalPayment.metadata)
checkpoint.merchantUid          // From Redis checkpoint (NOT from canonicalPayment.metadata)
```

## Validation Rules (Fail Closed)

**BEFORE** persisting to Redis checkpoint:

```
if (!a2uData.customerAmount || typeof a2uData.customerAmount !== "number") {
  // REJECT - cannot proceed without exact customer amount
  return { error: "Incomplete A2U response: missing customerAmount", manual_review_required: true }
}

if (!a2uData.merchantAmount || typeof a2uData.merchantAmount !== "number") {
  // REJECT - cannot proceed without exact merchant amount
  return { error: "Incomplete A2U response: missing merchantAmount", manual_review_required: true }
}

if (a2uData.horizonFeeCharged === undefined || typeof a2uData.horizonFeeCharged !== "number") {
  // REJECT - cannot proceed without exact fee
  return { error: "Incomplete A2U response: missing horizonFeeCharged", manual_review_required: true }
}
```

**BEFORE** DB write (re-read checkpoint):

```
if (!checkpoint.customerAmount || !checkpoint.merchantAmount || 
    checkpoint.horizonFeeCharged === undefined || !checkpoint.merchantId || !checkpoint.merchantUid) {
  // REJECT - checkpoint missing required fields
  return { error: "Checkpoint incomplete - manual review required", status: 500 }
}
```

## Correct Calculation

```
appNetImpact = customerAmount - merchantAmount - horizonFeeCharged
```

This represents what the app absorbs:
- Positive = app loss (system subsidy to merchant)
- Negative = app gain (margin/arbitrage)
- Zero = break-even settlement

## DB Record Call

```typescript
const dbResult = await recordA2UTransactionAtomic({
  u2aIdentifier: checkpoint.piPaymentId,           // From checkpoint
  u2aTxid: checkpoint.u2aTxid,                     // From checkpoint
  a2uIdentifier: checkpoint.a2uPaymentId,          // From checkpoint
  a2uTxid: checkpoint.a2uTxid,                     // From checkpoint (actual Horizon txid)
  merchantId: checkpoint.merchantId,               // From checkpoint (NOT canonicalPayment.metadata)
  merchantUid: checkpoint.merchantUid,             // From checkpoint (NOT canonicalPayment.metadata)
  customerAmount: checkpoint.customerAmount,       // Verified U2A
  merchantAmount: checkpoint.merchantAmount,       // Actual A2U transfer
  horizonFeeCharged: checkpoint.horizonFeeCharged, // Actual fee
  appCommission: checkpoint.appCommission,         // From checkpoint
})
```

## Merchant Balance Credit (Idempotent)

The DB function `recordA2UTransactionAtomic` MUST:

1. Credit `merchant_balances` with `merchantAmount` ONLY (not customerAmount)
2. Use an idempotent receipt mechanism (e.g., unique constraint on (a2uTxid, merchantId))
3. Prevent double-crediting even if called twice with same txid

## DB Failure Recovery

If DB write fails after A2U succeeds:

1. Do NOT retry the A2U submission (it already succeeded)
2. Mark payment with `requiresDbReconciliation: true`
3. Return status 202 with known values:
   ```json
   {
     "status": "settlement_pending",
     "paymentId": "...",
     "a2uTxid": "...",
     "customerAmount": 100.0,
     "merchantAmount": 99.5,
     "horizonFeeCharged": 0.5,
     "requiresDbReconciliation": true
   }
   ```
4. Include a message: "A2U succeeded but DB write failed - manual review required"

## Final Settlement Update

After DB commit succeeds:

```typescript
const finalPayment = {
  ...checkpoint,
  status: "settled_to_merchant",
  settledAt: new Date().toISOString(),
  piCompletionPending: false,  // Pi /complete finished
  piCompleted: true,           // Settlement fully completed
}

await redis.set(`payment:${paymentId}`, JSON.stringify(finalPayment))
```

## Forbidden Patterns

❌ NO silent fallbacks:
```
customerAmount || payment.amount          // FORBIDDEN
merchantAmount || customerAmount || 0     // FORBIDDEN
horizonFeeCharged || feeCharged || 0      // FORBIDDEN
appCommission || 0                         // FORBIDDEN
```

❌ NO metadata fallbacks:
```
merchantId || canonicalPayment.metadata?.merchantId    // FORBIDDEN
merchantUid || canonicalPayment.metadata?.merchantUid  // FORBIDDEN
```

❌ NO recalculation from request data:
```
// After DB write, use checkpoint.appNetImpact, never recalculate
const appNetImpact = customerAmount - merchantAmount - fee  // FORBIDDEN
```

## Audit Trail

Every financial operation MUST log:
1. All input amounts from A2U response (before checkpoint)
2. All checkpoint amounts (after re-read)
3. All DB parameters passed to `recordA2UTransactionAtomic`
4. Final accounting reconciliation with exact amounts
5. Any reconciliation errors with manual_review_required flag

## Summary

- **No fallbacks**: Every amount field MUST exist or operation fails
- **Checkpoint authority**: Re-read from Redis before ANY DB write
- **Separate storage**: customerAmount, merchantAmount, horizonFeeCharged stored separately
- **Merchant credit**: Only merchantAmount credited, not customerAmount
- **Correct calculation**: appNetImpact = customerAmount - merchantAmount - horizonFeeCharged
- **Idempotent receipts**: Balance cannot be credited twice for same a2uTxid
- **DB failure recovery**: Know a2uTxid and all amounts for manual reconciliation
