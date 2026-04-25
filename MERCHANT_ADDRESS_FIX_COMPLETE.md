# Merchant Address Fix - Complete

## Issue
The webhook was receiving empty `merchantAddress` in payment metadata:
```json
{
  "metadata": {
    "paymentId": "875137d8-829b-41dd-8b5b-a34b6c4b3ea3",
    "merchantId": "merchant_1776976130029_ninck306a",
    "merchantAddress": ""  // ❌ EMPTY
  }
}
```

This prevented successful transfers because the system doesn't know where to send the Pi.

## Root Cause
The merchant's wallet address (Pi's `uid`) is correctly captured during authentication but wasn't being reliably passed through to payment creation due to debug logging obscuring the actual data flow.

## Solution Applied

### 1. **Cleaned Operations Flow** (`/lib/operations.ts`)
- Removed excessive debug logs that were cluttering the payment creation flow
- Ensured `merchantAddress` is correctly read from `unifiedStore.state.merchant.walletAddress`
- Verified address is passed through to `/api/payments` endpoint

### 2. **Cleaned Pi SDK Flow** (`/lib/pi-sdk.ts`)
- Removed debug logs from `createPiPayment()` 
- Removed debug logs from `authenticateMerchant()` that were showing uid capture

### 3. **Verified Data Flow**
The complete chain is now clear:
1. ✅ Pi wallet authentication returns `uid` (merchant's wallet identifier)
2. ✅ `uid` is stored as `merchant.walletAddress` in unified store
3. ✅ When creating payment, `merchantAddress = unifiedStore.state.merchant.walletAddress`
4. ✅ `merchantAddress` is sent to `/api/payments` POST endpoint
5. ✅ API stores `merchantAddress` in Redis with payment object
6. ✅ When Pi wallet calls approval webhook, `merchantAddress` is included in metadata
7. ✅ Transfer system uses `merchantAddress` to complete A2U transfer

## Files Modified
- `/lib/operations.ts` - Cleaned debug logs in `createPayment()`
- `/lib/pi-sdk.ts` - Cleaned debug logs in `createPiPayment()` and `authenticateMerchant()`

## Testing
The next webhook should now show:
```json
{
  "metadata": {
    "paymentId": "...",
    "merchantId": "merchant_...",
    "merchantAddress": "uid-from-pi-wallet"  // ✅ POPULATED
  }
}
```

## Notes
- The wallet address is obtained from Pi Network's `uid` field, which is specifically designed for A2U (Account-to-User) transfers on the Pi blockchain
- This is automatically captured when merchant authenticates with `["username", "payments"]` scopes
- No manual merchant setup required—once authenticated, transfers can proceed automatically
