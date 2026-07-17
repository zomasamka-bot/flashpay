# EXACT Payment Status Migration Specification

## Global Status Model (7 States)

Authoritative statuses defined in `lib/types.ts`:
```typescript
export type PaymentStatus = "pending" | "failed" | "cancelled" | "paid_to_app" | "settlement_pending" | "settled_to_merchant" | "settlement_failed"
```

### Status Semantics (EXACT):
- **pending**: Initial state, awaiting Pi Wallet confirmation (U2A in progress)
- **failed**: U2A failed OR pre-settlement failure (U2A never completed)
- **cancelled**: Customer cancelled payment before completion
- **paid_to_app**: U2A completed, app received funds, settlement starting
- **settlement_pending**: A2U submitted to Horizon, awaiting blockchain confirmation
- **settled_to_merchant**: A2U completed on Horizon - FINAL SUCCESS (never downgrades)
- **settlement_failed**: A2U settlement failed AFTER Horizon submission

### Counting Rules (EXACT):
- **Final Success**: ONLY `settled_to_merchant` counts as paid volume and final success
- **Processing**: `paid_to_app` + `settlement_pending` + `pending` counted as processing
- **Failed**: `settlement_failed` + `failed` counted as failures
- **Cancelled**: `cancelled` counted separately

## Files Updated (EXACT)

### 1. lib/types.ts ✅
- **Status**: Already correct (PaymentStatus type defined with all 7 statuses)
- **No changes needed**

### 2. lib/payment-status.ts ✅
- **Status**: Already correct
- **Functions implemented**:
  - `isProcessingStatus()` → true for `paid_to_app` | `settlement_pending`
  - `isFinalStatus()` → true for `settled_to_merchant` only
  - `isPaid()` → true for `settled_to_merchant` only
  - `isFailedStatus()` → true for `failed` | `settlement_failed` | `cancelled`
  - `getStatusLabel()` → human-readable labels for all 7 statuses
  - `getStatusColor()` → color for all 7 statuses (settled=green, failures=red, processing=yellow/blue, cancelled=gray)
  - `validateStatusTransition()` → prevents downgrade from `settled_to_merchant`
  - `countPaidPayments()` → counts ONLY `settled_to_merchant`
  - `getSettlementStats()` → tracks paid/processing/failed separately

### 3. lib/server-payments-store.ts ✅
- **Status**: FIXED
- **Changed**: Payment interface now uses `PaymentStatus` type instead of hardcoded string union
- **Impact**: Consistent with types.ts across entire app

### 4. app/merchant/payments/page.tsx ✅
- **Status**: FIXED  
- **Changes**:
  - Filter state now includes `failed` status option
  - Stats object now tracks `failed: payments.filter(p => p.status === "settlement_failed" || p.status === "failed").length`
  - Status color mapping adds `case "failed": return "bg-red-100..."` 
  - Filter dropdown options now display all 7 statuses with exact labels

### 5. app/payments/page.tsx ✅
- **Status**: FIXED
- **Changes**:
  - StatusConfig adds `failed` status mapping with XCircle icon and red color
  - Distinguishes between `settlement_failed` and `failed` (both destructive but different labels)

## Filtering Logic (EXACT)

Everywhere statuses are filtered:
- "all" → no filter
- "settled_to_merchant" → final success only
- "paid_to_app" → app received funds, settlement not complete
- "settlement_pending" → settlement in progress
- "settlement_failed" → settlement failed on blockchain
- "failed" → U2A failed, never reached settlement
- "pending" → awaiting U2A confirmation
- "cancelled" → user cancelled

## Badge/Label Colors (EXACT)

| Status | Color | Label |
|--------|-------|-------|
| settled_to_merchant | Green | "Settled" |
| paid_to_app | Blue | "Paid" |
| settlement_pending | Yellow | "Processing" |
| settlement_failed | Red | "Settlement Failed" |
| failed | Red | "Failed" |
| pending | Yellow | "Pending" |
| cancelled | Gray | "Cancelled" |

## Statistics Calculation (EXACT)

```typescript
// Merchant Dashboard
stats = {
  total: payments.length,
  paid: payments.filter(p => p.status === "settled_to_merchant").length,
  pending: payments.filter(p => p.status === "settlement_pending" || p.status === "paid_to_app" || p.status === "pending").length,
  failed: payments.filter(p => p.status === "settlement_failed" || p.status === "failed").length,
  totalVolume: payments.filter(p => p.status === "settled_to_merchant").reduce((sum, p) => sum + p.amount, 0),
}
```

## API/Redis Records (EXACT)

All payment records in Redis use EXACT status from PaymentStatus union:
- On creation: `status: "pending"`
- After U2A webhook: `status: "paid_to_app"`, `paidAt: timestamp`
- After A2U submission: `status: "settlement_pending"`
- After A2U complete: `status: "settled_to_merchant"`, `settledAt: timestamp`
- On U2A failure: `status: "failed"`
- On A2U failure: `status: "settlement_failed"`
- On user cancel: `status: "cancelled"`

## Type Safety (EXACT)

```typescript
// lib/types.ts
export type PaymentStatus = "pending" | "failed" | "cancelled" | "paid_to_app" | "settlement_pending" | "settled_to_merchant" | "settlement_failed"

export interface Payment {
  status: PaymentStatus  // Enforced by TypeScript - no string literals allowed
  // ...
}
```

## Retry Rules (EXACT)

- **pending**: Retry U2A webhooks until `paid_to_app` or `failed`
- **paid_to_app**: Initiate A2U settlement
- **settlement_pending**: Retry A2U polling until `settled_to_merchant` or `settlement_failed`
- **settled_to_merchant**: FINAL - never retry, never downgrade
- **settlement_failed**: Manual review required, do NOT retry A2U
- **failed**: Manual review required, do NOT retry U2A
- **cancelled**: FINAL - never transition

## Removed Statuses

- ❌ "paid" - replaced with "settled_to_merchant"
- ❌ "complete" - replaced with "settled_to_merchant"

## Verification Checklist

- ✅ lib/types.ts has all 7 statuses in PaymentStatus union
- ✅ lib/payment-status.ts implements all status utility functions
- ✅ lib/server-payments-store.ts uses PaymentStatus type
- ✅ app/merchant/payments/page.tsx has "failed" in filter and stats
- ✅ app/payments/page.tsx has "failed" in status config
- ✅ All getStatusColor() mappings include all 7 statuses
- ✅ All getStatusLabel() mappings include all 7 statuses
- ✅ Settlement statistics only count "settled_to_merchant" as paid
- ✅ No hardcoded string literals for status, always use PaymentStatus type
- ✅ Status transitions validated against downgrade rules
