# Recovery Endpoint Authorization Fix

## Problem
Recovery endpoint `/api/recovery/[id]` accepted any request with a paymentId without verifying authorization. PaymentId alone does not authorize recovery.

## Solution
Added server-to-server authorization using `x-flashpay-internal-secret` header:

### Authorization Layer
- **Header required**: `x-flashpay-internal-secret` (server-only, fail-closed)
- **Secret source**: `config.a2uInternalSecret` (NOT exposed to client)
- **Validation**: Timing-safe comparison (prevents timing attacks)
- **No fallback**: Missing or invalid secret = 403 Forbidden
- **Server-to-server only**: Used by `/lib/operations.ts` backend calls

### Authorization Implementation
```typescript
// In recovery endpoint
const providedSecret = request.headers.get("x-flashpay-internal-secret")

if (!providedSecret || !config.a2uInternalSecret) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
}

// Timing-safe comparison (crypto.timingSafeEqual)
const secretBuffer = Buffer.from(config.a2uInternalSecret)
const providedBuffer = Buffer.from(providedSecret)
timingSafeEqual(secretBuffer, providedBuffer)
```

### Caller Updates
Both recovery callers in `/lib/operations.ts` now include the secret:
- Line ~432: State 2 (requiresDbReconciliation) caller
- Line ~532: State 4 (piCompleted DB pending) caller

```typescript
const response = await fetch(`${config.appUrl}/api/recovery/${paymentId}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-flashpay-internal-secret": config.a2uInternalSecret,
  },
})
```

## Recovery Order (Exact Sequence)

### 1. settled_to_merchant
- **Check**: `payment.status === "settled_to_merchant"`
- **Action**: Return stored success (no recovery needed)
- **Response**: 200 with u2aTxid and a2uTxid

### 2. requiresDbReconciliation + a2uTxid + horizonSuccessFlag
- **Check**: All three conditions true
- **Action**: DB-only reconciliation via recordA2UTransactionAtomic
- **Data source**: Redis payment record (trusted)
- **After success**: Mark as settled_to_merchant, update Redis
- **Response**: 200 with a2uTxid

### 3. settlement_pending + piCompletionPending
- **Check**: Both conditions true
- **Action**: Client must retry Pi /complete endpoint
- **Response**: 400 (recovery not handled server-side)

### 4. piCompleted + a2uTxid + horizonSuccessFlag (no requiresDbReconciliation)
- **Check**: All conditions true, DB reconciliation flag NOT set
- **Action**: DB-only reconciliation via recordA2UTransactionAtomic
- **Data source**: Redis payment record (trusted)
- **After success**: Mark as settled_to_merchant, update Redis
- **Response**: 200 with a2uTxid

### 5. settlement_failed
- **Check**: `payment.status === "settlement_failed"`
- **Sub-checks**:
  - If `a2uTxid || horizonSuccessFlag` exists: **Never restart** → 400 (irreversible)
  - If both missing: Recoverable → 400 (client may retry)
- **Prevention**: Stops restart of Horizon when partial success detected

## Critical Security Rules

✅ **Authorization**: Server-to-server only, fail-closed, timing-safe
✅ **Data source**: Only Redis payment record used (never request body)
✅ **DB operations**: Only in states 2 and 4
✅ **State ordering**: DB reconciliation (state 2) before generic settlement_pending (state 3)
✅ **Irreversible protection**: Never restart when a2uTxid or horizonSuccessFlag present
✅ **No client bypass**: Client cannot perform DB operations or override state

## Files Modified
- `/app/api/recovery/[id]/route.ts`: Added authorization layer and timing-safe validation
- `/lib/operations.ts`: Both callers (lines ~432, ~532) now include secret header
