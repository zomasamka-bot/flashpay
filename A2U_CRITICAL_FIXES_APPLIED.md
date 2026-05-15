# A2U Critical Fixes - Horizon Error Logging & Merchant Balance Timing

**Date**: 2026-05-15  
**Status**: ✅ COMPLETE

## Issues Fixed

### 1. ❌ Insufficient Horizon Error Logging
**Problem**: When Horizon rejected signed transactions with HTTP 400, only the message was logged:
```
STEP 3 FAILED: Horizon submission error
Request failed with status code 400
```

This prevented diagnosis of the actual cause:
- Sequence number mismatch
- Insufficient balance
- Invalid network passphrase
- Malformed transaction
- Invalid destination

**Solution**: Enhanced error logging in `/app/api/pi/a2u/route.ts` (2 locations):
- ✅ Log `error.response.status` (HTTP status code)
- ✅ Log `error.response.data` (full Horizon response)
- ✅ Log `error.response.data.extras.result_codes` (Stellar error codes)
- ✅ Log `error.response.data.extras.result_xdr` (failed transaction XDR)
- ✅ Log full error object as JSON for complete context

Now Horizon rejection errors will show:
```
[Pi A2U] HTTP Status Code: 400
[Pi A2U] Horizon response.data: { "type": "transaction_failed", "title": "Transaction Malformed", ... }
[Pi A2U] Result codes: { "transaction": "tx_failed", "operations": [...] }
[Pi A2U] Result XDR: <base64-encoded-failed-transaction>
```

---

### 2. ❌ Merchant Balance Updating Before A2U Succeeds
**Problem**: In `/app/api/pi/complete/route.ts`:
```javascript
// Line 254 (OLD) - Updates balance IMMEDIATELY
recordTransactionToPG(...) // Updates merchant balance

// Line 270+ (OLD) - THEN attempts A2U
await fetch(/api/pi/a2u) // Might fail

// Result: Merchant balance updated even if A2U failed ❌
```

This caused merchant balance to increase before:
- Horizon transaction submission succeeded
- TXID/hash was retrieved
- Pi `/complete` endpoint acknowledged the settlement

**Solution**: Moved balance update to ONLY happen after A2U succeeds:
```javascript
// NEW: Don't update balance yet
// recordTransactionToPG removed from line 254

// NEW: Attempt A2U transfer (lines 270+)
await fetch(/api/pi/a2u)

// NEW: Only if A2U succeeds - UPDATE BALANCE (line 327+)
if (a2uResponse.ok && a2uData.success) {
  recordTransactionToPG(...) // NOW update merchant balance
  console.log("✅ PostgreSQL transaction recorded - merchant balance updated")
}
```

---

## Files Modified

### `/app/api/pi/a2u/route.ts`
**Changes**:
- Line ~492: Enhanced first Horizon error catch block
  - Added detailed `error.response.data` logging
  - Added HTTP status code logging
  - Added `extras.result_codes` logging
  - Added `extras.result_xdr` logging
  - Added full error object JSON dump
  
- Line ~931: Enhanced second Horizon error catch block (same improvements)

**Impact**: A2U settlement errors now provide complete diagnostic information

### `/app/api/pi/complete/route.ts`
**Changes**:
- Line 250: Removed `recordTransactionToPG()` call from early position
- Line 327: Moved `recordTransactionToPG()` into A2U-SUCCESS block
  - Balance only updates after `a2uResponse.ok && a2uData.success`
  - Merchant balance confirmed increased in console: `merchant balance updated`

**Impact**: Merchant balance now only updates after complete A2U settlement

---

## Testing Checklist

✅ User-to-App (U2A) flow untouched - customer payments work normally  
✅ A2U Horizon error logging - check logs show full error details  
✅ Balance timing - verify logs show:
  1. `A2U TRANSFER COMPLETE` message
  2. THEN `merchant balance updated` message

If Horizon rejects:
- Check logs for `Result codes` and `Result XDR`
- Common issues: `INSUFFICIENT_BALANCE`, `SEQUENCE_OUT_OF_RANGE`, `INVALID_SIGNATURE`

---

## Timeline of A2U Execution (Fixed)

```
1. Customer pays → /api/pi/complete webhook called
2. Payment marked PAID in Redis
3. Return 200 OK to Pi API ← FAST RESPONSE
4. [Background] A2U transfer starts:
   - Create/reuse payment on Pi API
   - Load account from Horizon
   - Build & sign Stellar transaction
   - Submit signed XDR to Horizon ← NOW LOGS FULL ERROR IF FAILS
   - Get TXID from Horizon response
   - Send TXID to Pi /complete endpoint
5. [Only if step 4 succeeds] Update merchant balance ← CRITICAL FIX
6. [Only if step 5 succeeds] Return success response
```

---

## Error Example: Now Visible

**Before (blind)**:
```
Request failed with status code 400
```

**After (diagnostic)**:
```
HTTP Status Code: 400
Horizon response.data: {
  "type": "transaction_failed",
  "title": "Transaction Malformed",
  "detail": "...",
  "extras": {
    "result_codes": {
      "transaction": "tx_failed",
      "operations": ["op_invalid"]
    },
    "result_xdr": "AAAA..."
  }
}
```

This reveals the actual Stellar error for immediate debugging.

---

## Notes

- User-to-App payment flow completely untouched ✅
- A2U settlement now has complete error visibility
- Merchant balance integrity ensured - only updates on confirmed settlement
- Logs are non-blocking and comprehensive
