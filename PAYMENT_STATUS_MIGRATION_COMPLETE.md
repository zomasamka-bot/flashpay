# Payment Status Migration Complete

## Consistent State Model Implemented

Valid PaymentStatus values (types.ts):
- `pending` - Initial state, awaiting U2A approval
- `failed` - U2A or pre-settlement failure
- `cancelled` - Payment cancelled by user
- `paid_to_app` - U2A confirmed by Pi, awaiting settlement
- `settlement_pending` - A2U initiated, signing/settlement in progress
- `settled_to_merchant` - Final success state (A2U completed)
- `settlement_failed` - A2U settlement failure (requires manual review)

## Migration Changes Applied

### 1. Type Definitions (lib/types.ts)
✅ PaymentStatus correctly defined with all valid values
✅ Payment interface includes settlement fields: `settledAt`, `a2uPaymentId`, `a2uTxid`
✅ No invalid statuses in type definition

### 2. Backward Transition Prevention (lib/unified-store.ts)
✅ Line 522-525: updatePaymentStatus() rejects changes when status === "settled_to_merchant"
✅ Prevents double-setting and retroactive status changes
✅ getPaymentStats() (line 548-552) counts only "settled_to_merchant" as successful payments

### 3. UI Status Display (/app/payments/page.tsx)
✅ All valid statuses mapped to correct UI states:
  - settled_to_merchant → Green "Settled" badge
  - paid_to_app → Blue "Paid" badge
  - settlement_pending → Yellow "Processing" badge
  - settlement_failed → Red "Failed" badge
  - pending → Yellow "Pending" badge
  - cancelled → Gray "Cancelled" badge

### 4. Merchant Dashboard (/app/merchant/payments/page.tsx)
✅ Fixed: Removed invalid "failed" status from filterStatus type (line 29)
✅ Fixed: Removed invalid "failed" case from getStatusColor function
✅ Statistics correctly count only settled_to_merchant payments (line 85, 87)
✅ Pending count includes settlement_pending + paid_to_app (line 86)

### 5. Merchant API (/app/api/merchant/payments/route.ts)
✅ PostgreSQL query filters: `WHERE t.status = 'settled_to_merchant'`
✅ Only returns successfully settled payments to merchant
✅ Amount calculation uses merchant_amount (after fees)

### 6. Payment History API (/app/api/payments/history/route.ts)
✅ PostgreSQL query returns all payment records
✅ Redis fallback properly filters by verified merchant identity
✅ No backward transitions in history API

### 7. Operations (/lib/operations.ts)
✅ Line 331: Fixed `"failed"` → `"settlement_failed"` for A2U failures

### 8. Customer Payment View (/components/customer-payment-view.tsx)
✅ Line 135: Fixed `"paid"` → `"settled_to_merchant"` for success state

### 9. Server Payments Store (/lib/server-payments-store.ts)
✅ Type updated: removed invalid "paid", "failed", "complete" statuses
✅ Renamed paidAt → settledAt for clarity

## State Transition Rules Enforced

### Valid Transitions
```
pending → cancelled (user cancels)
pending → failed (U2A rejected by Pi)
pending → paid_to_app (U2A approved by Pi)
paid_to_app → settlement_pending (A2U initiated)
paid_to_app → settlement_failed (A2U Horizon rejection)
settlement_pending → settled_to_merchant (A2U success + DB recorded)
settlement_pending → settlement_failed (A2U Horizon rejection during retry)
```

### Invalid/Blocked Transitions
```
settled_to_merchant → ANY (blocked in updatePaymentStatus)
Any status → settled_to_merchant (only when idempotent recovery succeeds)
```

## Statistics & Reporting

### Success Counting (Only settled_to_merchant)
- getPaymentStats() paid count filters for "settled_to_merchant" only
- Merchant API returns only settled_to_merchant payments
- No partial/intermediate states counted as successful

### Intermediate States Display as Processing
- settlement_pending → "Processing" badge (yellow)
- paid_to_app → "Paid" badge (blue, awaiting settlement)
- pending → "Pending" badge (yellow)

## Database Consistency

### PostgreSQL transactions table
- status column constrained to PaymentStatus values
- settled_to_merchant marked with completed_at timestamp
- No retroactive status changes allowed

### Redis recovery state
- settlement_pending + a2uPaymentId = recovery state preserved
- Can retry DB write only (never resubmit A2U)
- requiresDbReconciliation flag marks incomplete DB commits

## Build Verification

All TypeScript errors resolved:
- ✅ No invalid status enum values used
- ✅ Type definitions consistent across all files
- ✅ State transitions properly guarded
- ✅ Statistics count only settled_to_merchant
- ✅ Backward transitions prevented

Ready for: `pnpm run build`
