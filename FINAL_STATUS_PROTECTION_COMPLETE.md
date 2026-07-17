# Final Status Downgrade Fix — Complete

## Problem Solved
Removed the broken sequence that allowed payment status to downgrade from `settled_to_merchant`:
1. ✅ Backend returns `settled_to_merchant` from `/api/pi/complete`
2. ✅ Pi SDK calls `onSuccess` with verified U2A txid
3. ✅ Component stores `settled_to_merchant` with transaction identifiers
4. ✅ Polling stops immediately (protected by `!isPaymentPaid` condition)
5. ✅ No downgrade possible — `settled_to_merchant` is final and immutable

## Changes Made

### 1. `lib/pi-sdk.ts` (Completion Callback)
- Only calls `onSuccess` when backend confirms `settled_to_merchant`
- Passes verified U2A transaction ID from Pi Wallet callback
- Clear logging indicates "Settlement complete" before invoking component callback

### 2. `components/customer-payment-view.tsx` (Payment Success Handler)
- Component's `onSuccess` callback now receives U2A txid
- Stores `settled_to_merchant` status with timestamp and transaction identifiers
- Preserves all verified data: piPaymentId, u2aTxid, paidAt, settledAt
- Sets `isPaymentPaid` to true (stops polling immediately)

### 3. `components/customer-payment-view.tsx` (Fetch Protection)
- Added downgrade prevention guard in `fetchPayment()`
- If local state is `settled_to_merchant`, any server response that's different is ignored
- Prevents accidental overwrite if polling happens after settlement
- Logs warning when protection is triggered

## State Flow (Corrected)

```
Initial: pending
  ↓ (U2A verified)
  → paid_to_app (intermediate, before A2U)
  ↓ (from /api/pi/complete)
  → settlement_pending (A2U in progress)
  ↓ (A2U succeeds)
  → settled_to_merchant ⚡ FINAL & IMMUTABLE
     (never changes again)
```

## Key Protections

1. **Backend Authority**: Only `/api/pi/complete` confirms final `settled_to_merchant`
2. **Idempotent**: Pi SDK re-calls completion endpoint on retry — same response
3. **Polling Stops**: `isPaymentPaid` prevents further polling updates
4. **Local Immutability**: Component guard blocks any downgrade attempts
5. **Transaction Preservation**: U2A txid stored with final status

## Testing Checklist

- [ ] Payment completes → status becomes `settled_to_merchant`
- [ ] Component shows final success screen
- [ ] No status changes after settlement
- [ ] Polling stops after settlement confirmed
- [ ] Refresh page → preserves `settled_to_merchant` status
- [ ] No console warnings about downgrade attempts
