# Client-to-Server Completion Contract Fix

## Summary

Fixed the broken completion contract between `lib/pi-sdk.ts` and `/api/pi/complete`. The client now sends only **verified Pi identifiers** (piPaymentId + txid) that come directly from the Pi Wallet callback, never client-provided merchant or user data.

## Before (Broken)

**Client (`lib/pi-sdk.ts`)** sent:
```json
{ "paymentId": "user-generated-id" }
```

**Server (`/api/pi/complete`)** then had to:
- Scan all Redis `payment:*` keys to find one matching piPaymentId (inefficient)
- Hope the piPaymentId was stored in the payment record

**Problem**: Client controls the lookup identifier; server never verifies canonical Pi payment data.

## After (Fixed)

**Client (`lib/pi-sdk.ts`)** now sends:
```json
{ "piPaymentId": "pi-wallet-generated", "txid": "pi-wallet-txid" }
```

Both values come directly from the Pi Wallet's `onReadyForServerCompletion` callback—never client-generated.

**Server (`/api/pi/complete`)** now:

1. **Looks up canonical Pi payment** using `piPaymentId` → Redis key `pi_payment:${piPaymentId}`
2. **Derives paymentId from metadata** → `canonicalPayment.metadata.paymentId`
3. **Loads actual payment record** → Redis key `payment:${paymentId}`
4. **Validates comprehensive fields**:
   - piPaymentId matches
   - amount matches canonical record
   - direction is "u2a"
   - metadata.paymentId matches derived value
   - txid from wallet matches canonical record
   - status is not cancelled
   - No downgrade from settled_to_merchant

5. **Never trusts client-provided data**:
   - Merchant ID/UID: loaded from canonical payment metadata
   - Addresses: never sent by client
   - Amount: always from canonical record
   - All settlement data: from server storage only

## Contract Details

### Request Body: `/api/pi/complete`

```typescript
{
  piPaymentId: string;  // From Pi Wallet callback (verified signature)
  txid: string;         // From Pi Wallet callback (verified signature)
}
```

### Canonical Pi Payment Validation

Server validates these fields from `pi_payment:${piPaymentId}`:
- `piPaymentId` — matches request parameter
- `amount` — must match payment record amount
- `direction` — must be "u2a"
- `metadata.paymentId` — used to derive lookup key
- `metadata.merchantId` — trusted merchant ID
- `metadata.merchantUid` — trusted merchant user ID
- `txid` — must match request txid exactly
- `status` — must not be "cancelled"

### State Transitions

Payment record states during completion:

```
pending 
  ↓ (U2A verified, piPaymentId + txid stored)
paid_to_app 
  ↓ (A2U createPayment initiated)
settlement_pending 
  ↓ (A2U signed on Horizon)
settled_to_merchant (FINAL)

OR

settlement_failed (requires manual review, no downgrade)
```

### Verified Identifiers Persisted

After successful U2A verification, persist:
```typescript
{
  piPaymentId: string;   // From Pi Wallet callback
  u2aTxid: string;       // From Pi Wallet callback
  paidAt: string;        // ISO timestamp
  // These are never updated after paid_to_app
}
```

## Recovery Semantics

### Idempotent on piPaymentId + txid

If `/api/pi/complete` receives the same `(piPaymentId, txid)` pair twice:

1. **First request**: Completes normally → settled_to_merchant or settlement_pending
2. **Retry request**: Returns current state → never downgrades, never re-processes

### If settled_to_merchant already:
```json
{ "status": "settled_to_merchant", "paymentId": "...", "txid": "..." }
```
Client sees final state, no re-processing.

### If settlement_pending with a2uPaymentId:
Reattempts completion of the SAME A2U transfer (no new transfer created).

## Security Implications

### ✅ Fixed

1. **Client cannot fabricate merchant data** — merchant ID/UID come only from server storage
2. **Client cannot change payment amount** — validated against canonical record
3. **Client cannot spoof addresses** — addresses stored server-side after A2U createPayment
4. **piPaymentId is verified by Pi Wallet signature** — not user input
5. **txid is verified by Pi Wallet signature** — not user input

### ✅ Enforced

- No direct Redis key lookup from client parameters
- No scanning all payment:* keys (inefficient, unsafe)
- Canonical payment data is source of truth
- Status transitions are unidirectional (never downgrade from settled_to_merchant)
- Settlement data persisted BEFORE database calls (crash-safe recovery)

## Implementation Changes

### lib/pi-sdk.ts

```typescript
// OLD
fetch(`${config.appUrl}/api/pi/complete`, {
  body: JSON.stringify({ paymentId }),  // ❌ Client-provided
})

// NEW
fetch(`${config.appUrl}/api/pi/complete`, {
  body: JSON.stringify({ piPaymentId, txid }),  // ✅ From Pi Wallet callback
})
```

### /api/pi/complete/route.ts

```typescript
// OLD: Scan all payment:* keys
const paymentKeys = await redis.keys("payment:*")
for (const key of paymentKeys) {
  const p = await redis.get(key)
  if (p.piPaymentId === piPaymentId) {
    paymentId = key.replace("payment:", "")
    break
  }
}

// NEW: Direct lookup of canonical Pi payment
const canonicalKey = `pi_payment:${piPaymentId}`
const canonicalPayment = await redis.get(canonicalKey)
const paymentId = canonicalPayment.metadata.paymentId  // ✅ Derived from canonical
const payment = await redis.get(`payment:${paymentId}`)
```

## Testing

1. **Verify canonical Pi payment lookup** works correctly
2. **Confirm idempotence** — same (piPaymentId, txid) pair returns same state
3. **Validate merchant data** comes only from server storage
4. **Confirm status never downgrades** from settled_to_merchant
5. **Test recovery** — simulate DB failure, verify retry completes correctly
