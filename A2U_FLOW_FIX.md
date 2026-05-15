# A2U (App-to-User) Transfer Flow Fix

## Problem Identified
The A2U transfer was failing with `user_not_found` error because:
1. ✗ `sessionAuthUid` was reaching A2U as `null`
2. ✗ App was sending `merchantUid` from Redis but it wasn't being stored properly
3. ✗ Pi returned `user_not_found` because UID was missing or invalid

## Root Cause
The flow chain was broken at the **payment creation step**:
- Merchant authenticates with Pi via `Pi.authenticate(["username", "payments", "wallet_address"])`
- `user.uid` is extracted and stored in `unifiedStore.state.merchant.uid`
- When creating a payment, the `merchantUid` was not being passed to the backend API
- The payment was created WITHOUT the `merchantUid` field
- When payment completed and A2U transfer was initiated, `merchantUid` was missing/empty

## Solution Implemented

### 1. Backend Payment API (`/app/api/payments/route.ts`)
**Added:**
- `merchantUid` field to Payment interface
- Validation that `merchantUid` is captured from request
- Storage of `merchantUid` in Redis with the payment object
- Return `merchantUid` in response to client

\`\`\`typescript
interface Payment {
  id: string
  merchantId: string
  merchantAddress?: string
  merchantUid?: string  // ← ADDED
  // ... rest of fields
}
\`\`\`

### 2. Frontend Operations (`/lib/operations.ts`)
**Already correct:**
- Gets `merchantUid` from `unifiedStore.state.merchant.uid`
- Passes it when calling `/api/payments`:
\`\`\`typescript
const response = await fetch(`${config.appUrl}/api/payments`, {
  method: "POST",
  body: JSON.stringify({ amount, note, merchantId, merchantUid }),
})
\`\`\`

### 3. Payment Completion (`/app/api/pi/complete/route.ts`)
**Already correct:**
- When payment is marked PAID, retrieves `existingPayment.merchantUid` from Redis
- Passes it to A2U transfer:
\`\`\`typescript
fetch(a2uUrl, {
  method: "POST",
  body: JSON.stringify({
    paymentId,
    merchantId,
    merchantUid: existingPayment.merchantUid,  // ← From Redis
    amount,
    memo,
  }),
})
\`\`\`

### 4. A2U Transfer (`/app/api/pi/a2u/route.ts`)
**Enhanced:**
- Comprehensive validation of `merchantUid` before sending to Pi
- Clear diagnostic logging
- Proper error messages indicating what went wrong
- Correct field name (`uid`) in Pi API request

## The Complete Flow (Now Fixed)

\`\`\`
1. Merchant logs in
   ├─ Pi.authenticate() returns user.uid
   └─ Store in unifiedStore.state.merchant.uid

2. Merchant creates payment
   ├─ Get merchantUid from unifiedStore.state.merchant.uid
   ├─ Call /api/payments with merchantUid
   ├─ Backend stores in Redis: { merchantUid, ... }
   └─ Payment created ✓

3. Customer pays merchant (U2A)
   ├─ Customer completes payment in Pi Wallet
   └─ Pi notifies /api/pi/complete

4. Payment completion
   ├─ Retrieve payment from Redis (includes merchantUid)
   ├─ Mark status as PAID
   ├─ Call /api/pi/a2u with merchantUid from Redis
   └─ Background operation (non-blocking)

5. App-to-User transfer
   ├─ Receive merchantUid from payment
   ├─ Validate it's not empty
   ├─ Send to Pi API with uid field
   ├─ Pi creates transfer to merchant wallet
   └─ Merchant receives funds ✓
\`\`\`

## Testing Checklist

- [ ] Merchant authenticates with Pi Wallet
  - Check: `unifiedStore.state.merchant.uid` is populated
  
- [ ] Merchant creates payment
  - Check: `/api/payments` request includes `merchantUid`
  - Check: Redis stores payment with `merchantUid` field
  - Check: Response includes `merchantUid`
  
- [ ] Customer pays
  - Check: `/api/pi/complete` logs show `merchantUid` in Redis
  
- [ ] A2U transfer initiated
  - Check: `/api/pi/a2u` logs show merchantUid being sent
  - Check: Pi API call successful (status 200)
  
- [ ] Funds appear in merchant wallet
  - Check on Pi Testnet wallet

## If Still Failing

Check these in order:

1. **Is merchantUid in store?**
   - Open browser DevTools > Application > LocalStorage
   - Look for `flashpay_unified_state`
   - Find `merchant.uid` field

2. **Is merchantUid in payment?**
   - Look at `/api/payments` logs
   - Search for "PAYMENT OBJECT CREATED"
   - Check `payment.merchantUid` is NOT empty

3. **Is merchantUid in Redis?**
   - Check `/api/pi/complete` logs
   - Search for "FULL PAYMENT FROM REDIS"
   - Check `merchantUid` value (should not be empty)

4. **Is A2U receiving it?**
   - Check `/api/pi/a2u` logs
   - Search for "A2U REQUEST RECEIVED"
   - Check if merchantUid is populated

5. **Pi API error?**
   - Check `/api/pi/a2u` logs for "PI API ERROR"
   - Common causes:
     - `user_not_found`: UID doesn't exist on Pi Network
     - Invalid UID format: UID is too short/long
     - `already_completed`: Payment already transferred (check Pi wallet)

## Key Files Changed

1. `/app/api/payments/route.ts` - Added merchantUid to interface and response
2. `/app/api/pi/a2u/route.ts` - Enhanced diagnostics and documentation
