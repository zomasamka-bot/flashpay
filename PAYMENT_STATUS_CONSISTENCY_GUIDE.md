# Payment Status Migration Complete

## Consistent State Model Implementation

The payment system now uses a unified 7-state model across all components, APIs, and data layers:

### Status States (from `lib/types.ts`)

```typescript
type PaymentStatus = "pending" | "paid_to_app" | "settlement_pending" | "settled_to_merchant" | "settlement_failed" | "failed" | "cancelled"
```

### State Semantics

| Status | Meaning | Category |
|--------|---------|----------|
| **pending** | Awaiting Pi Wallet confirmation | Initial |
| **failed** | U2A failed or pre-settlement failure | Terminal (Failure) |
| **cancelled** | Customer cancelled payment | Terminal (Failure) |
| **paid_to_app** | U2A completed, settlement starting | Intermediate |
| **settlement_pending** | A2U created but not yet signed | Intermediate |
| **settled_to_merchant** | A2U complete - **FINAL SUCCESS** | Terminal (Success) |
| **settlement_failed** | A2U settlement failed | Terminal (Failure) |

### Critical Rules

1. **Only `settled_to_merchant` is payment success**
   - Statistics, dashboards, and success displays count ONLY this status
   - `paid_to_app` and `settlement_pending` are processing, not success

2. **Never downgrade `settled_to_merchant`**
   - Once a payment reaches this status, it stays there
   - Validation logic in `lib/payment-status.ts` prevents downgrades
   - Idempotent recovery allows safe retries without state regression

3. **Intermediate states display as "Processing"**
   - `paid_to_app` → "Processing"
   - `settlement_pending` → "Processing Settlement"
   - Users see clear feedback during settlement flow

4. **Failure states are terminal**
   - `failed`, `cancelled`, `settlement_failed` are end states
   - Cannot transition out of these states
   - Require manual review or user action to retry

## Utility Functions (from `lib/payment-status.ts`)

```typescript
// Query payment success status
isPaid(status) → true only for "settled_to_merchant"

// Check if status is processing
isProcessingStatus(status) → true for "paid_to_app" | "settlement_pending"

// Check if status is failure
isFailedStatus(status) → true for "failed" | "settlement_failed" | "cancelled"

// Get UI labels
getStatusLabel(status) → human-readable string
getStatusColor(status) → Badge color variant

// Count paid payments for statistics
countPaidPayments(payments) → count of settled_to_merchant only

// Get settlement statistics
getSettlementStats(payments) → { paidCount, paidAmount, processingCount, ... }
```

## API Endpoints Using This Model

### POST `/api/pi/complete` 

**Flow:**
1. Verifies U2A payment from Redis
2. Sets status → `paid_to_app`
3. Calls `/api/pi/a2u` to begin settlement

**Status Transitions:**
- `pending` → `paid_to_app` (U2A verified)
- `paid_to_app` → `settlement_pending` (A2U created)
- `settlement_pending` → `settled_to_merchant` (A2U signed, DB committed)
- `settlement_pending` → `settlement_failed` (A2U failed)
- `paid_to_app` → `settlement_failed` (A2U failed during creation)

### POST `/api/pi/a2u`

**Behavior:**
- Internal endpoint called by `/api/pi/complete`
- Manages A2U settlement with lock-based concurrency
- Returns with status `settlement_pending` (202) or `settled_to_merchant` (200)
- Implements idempotent recovery: reuses stored A2U identifiers on retry

**Idempotent Recovery:**
```typescript
// If A2U IDs already stored, return them without resubmitting to Horizon
if (payment.a2uPaymentId && payment.a2uTxid) {
  return { success: true, status: 'settled_to_merchant' }
}
```

## Client Components Using This Model

### `components/customer-payment-view.tsx`

**Status Display:**
```typescript
import { getStatusLabel, getStatusColor, isPaid as isPaymentSettled } from "@/lib/payment-status"

// Display status badge with correct color
<Badge variant={getStatusColor(payment.status)}>
  {getStatusLabel(payment.status)}
</Badge>

// Check if truly paid for conditional rendering
if (isPaymentSettled(payment.status)) {
  // Show success message
}
```

**Polling Logic:**
- Polls every 2 seconds while status is NOT `settled_to_merchant`
- Stops polling once status is settled (final success)
- Handles intermediate states transparently

## Data Layers Honoring This Model

### Redis (transactional storage)
```typescript
// Payment stored with status field
{
  id: string
  status: PaymentStatus  // One of 7 states
  paid_to_app_at?: string
  settled_to_merchant_at?: string
  settlement_failed_at?: string
  // ...
}
```

### PostgreSQL (audit ledger)
```sql
-- Transactions recorded after status changes
-- Only settled_to_merchant transactions are recorded as "completed"
```

### Unified Store (in-memory)
```typescript
// Frontend state respects PaymentStatus type
const [paymentStatus, setPaymentStatus] = useState<PaymentStatus | null>(null)
```

## Statistics Calculation

**Correct Counting (using `lib/payment-status.ts`):**

```typescript
// ✅ CORRECT: Count only truly settled payments
const paidCount = payments.filter(p => isPaid(p.status)).length
const paidAmount = payments.filter(p => isPaid(p.status)).sum()

// ❌ WRONG: Would count in-progress settlements
const paidCount = payments.filter(p => p.status !== 'pending').length
const paidCount = payments.filter(p => p.status === 'paid_to_app').length
```

## Migration Checklist

- [x] Type definition updated: `PaymentStatus` with 7 states in `lib/types.ts`
- [x] Utility functions created: `lib/payment-status.ts`
- [x] Status labels and colors: `getStatusLabel`, `getStatusColor`
- [x] Payment success check: `isPaid()` returns true only for `settled_to_merchant`
- [x] Processing state check: `isProcessingStatus()` for UI feedback
- [x] Failure state check: `isFailedStatus()`
- [x] Statistics helpers: `countPaidPayments`, `getSettlementStats`
- [x] Customer UI updated: `components/customer-payment-view.tsx`
- [x] API endpoints honoring model: `/api/pi/complete`, `/api/pi/a2u`
- [x] Idempotent recovery: Prevents downgrades, safe retries
- [x] Consistency validated: All layers use same 7-state model

## Testing the Model

**To verify the migration is working:**

1. Create a payment → status should be `pending`
2. Confirm in Pi Wallet → status should be `paid_to_app`
3. Settlement begins → status should be `settlement_pending`
4. Settlement completes → status should be `settled_to_merchant` ✅
5. Verify statistics only count `settled_to_merchant` as paid
6. Verify UI displays intermediate states as "Processing"
7. Attempt retry on settled payment → idempotent, returns success
8. Verify no downgrade from `settled_to_merchant` to any earlier state

## Implementation Notes

- **Validation**: `validateStatusTransition()` prevents invalid downgrades
- **Recovery**: Stored A2U identifiers enable safe idempotent retries
- **UI**: Status labels and colors provide clear user feedback
- **Statistics**: Only `settled_to_merchant` counts as payment success
- **Consistency**: All layers (types, APIs, UI, database) use same model
