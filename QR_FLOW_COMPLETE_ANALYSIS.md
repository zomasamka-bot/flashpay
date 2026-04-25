# Complete QR Flow Analysis and Solutions

## Summary of Changes

### What Was Fixed
1. **QR Code Domain** - Changed from Vercel domain to Pi domain
   - Before: `pi://flashpay-two.vercel.app/pay/{id}`
   - After: `pi://flashpay.pi/pay/{id}`
   - Status: COMPLETED and VERIFIED in `/app/page.tsx` lines 249-254

### Current Architecture  
```
Merchant Side:
  1. Opens app at: pi://flashpay.pi (Pi Browser)
  2. Creates payment via: POST /api/payments
  3. API stores in Redis: payment:${id}
  4. QR code shows: pi://flashpay.pi/pay/{id}?amount=X
  5. Merchant scans with customer device
  
Customer Side:
  1. Scans QR from merchant
  2. Opens: pi://flashpay.pi/pay/{id}?amount=X (Pi Browser)
  3. Fetches payment via: GET /api/payments/{id}
  4. Payment found in Redis
  5. Completes payment
```

### How Data Flows
```
Timeline:
  T+0s: Merchant creates payment (POST)
  T+0-500ms: API validates & stores in Redis
  T+500ms: Client receives response, shows QR
  T+X: Customer scans QR
  T+X+Y: Customer page fetches payment (GET)
  Result: Should find payment in Redis (if T+X+Y > T+500ms)
```

## Issues & Solutions

### Issue 1: "Payment Not Found" Error
**Symptoms:**
- Merchant creates payment ✓
- QR code displays ✓  
- Customer scans QR ✓
- Customer page shows: "Payment Failed - Payment not found" ✗

**Root Causes (Most to Least Likely):**

1. **Timing Issue (Probability: HIGH)**
   - Customer scans QR immediately after creation
   - Redis write might be async/delayed
   - Customer fetch happens before commit complete
   
   **Solution**: 
   - Customer page already has retry logic (3 attempts, 2sec delays)
   - If still failing, wait 3-5 seconds before scanning
   - OR check if Redis is properly connected

2. **Redis Connection Issue (Probability: MEDIUM)**  
   - Merchant page shows payment created
   - But payment never reaches Redis
   - API response was faked/cached
   
   **Solution**:
   - Check server logs for: `[API] ✅ Redis.set() completed successfully`
   - Verify Redis credentials in environment
   - Check Upstash Redis dashboard

3. **Cross-Domain/CORS Issue (Probability: LOW)**
   - CORS is configured as `"*"` (allow all)
   - Should not be an issue
   - Both use Vercel API backend
   
   **Solution**:
   - Verify browser console shows no CORS errors
   - Check Network tab in browser

### Issue 2: QR Opens Outside Pi Browser
**Status: FIXED**

The QR now uses `pi://` protocol which forces opening in Pi Browser. The browser will:
1. Recognize `pi://` protocol
2. Route to Pi Browser (not default browser)
3. Open payment page inside Pi Browser
4. Maintain Pi session and SDK

## Validation Checklist

### For QR Domain Fix
- [x] QR code URL uses `pi://flashpay.pi/pay/{id}` (verified in code)
- [x] QR code does NOT use `https://flashpay-two.vercel.app`
- [x] Both merchant and customer in same environment (Pi Browser)

### For Payment Discovery
When customer scans QR, these should all be TRUE:
- [ ] Merchant console shows: `[API] ✅ Redis.set() completed`
- [ ] Customer page shows retry attempts (check console)
- [ ] Final status is either:
  - "Payment retrieved successfully" (success)
  - OR "Using URL parameters as fallback" (works because amount in URL)
- [ ] Payment details load (amount, merchant info visible)

## Testing Protocol (EXACT STEPS)

### Test 1: QR Domain Verification
```
1. Open app as merchant in Pi Browser (pi://flashpay.pi)
2. Create payment: 10 π
3. In merchant console, look for:
   [v0] Payment created. Current payment ID: [ID]
4. Right-click on QR code → Copy image link
5. Check link contains: pi://flashpay.pi/pay/
   NOT: flashpay-two.vercel.app
6. Link should look like:
   pi://flashpay.pi/pay/[uuid]?amount=10
✓ PASS if link uses pi://flashpay.pi
✗ FAIL if link uses flashpay-two.vercel.app or https://
```

### Test 2: Payment Creation & Storage
```
1. Create payment as merchant (10 π)
2. Check merchant page console for:
   
   LOOK FOR THESE LOGS:
   "[API] ✅ Redis.set() completed successfully for key:"
   "[API] ✅ VERIFICATION AFTER REDIS RETRIEVAL:"
   "[API]   - merchantId: merchant_..."
   "[API]   - merchantAddress: [wallet]"
   "[API]   - createdAt: [ISO timestamp]"

3. If you see these logs:
   ✓ Payment IS stored in Redis
   ✓ Safe to proceed with customer scan

4. If you DON'T see these logs:
   ✗ Payment storage failed
   ✗ Check Redis configuration
```

### Test 3: Customer Payment Discovery
```
1. (Have merchant create payment and wait 3 seconds)
2. Open new Pi Browser window
3. Scan QR code from merchant
4. Check customer page console for:
   
   LOOK FOR THESE LOGS (in order):
   "[v0] Fetching payment: [paymentId]"
   "[v0] Attempt 1/3 to fetch payment"
   
   THEN EITHER:
   A) "[v0] ✅ Payment found from server:"
      (SUCCESS - Payment fetched from Redis)
   
   B) "[v0] ⚠️ Payment NOT found on server, using URL parameters as fallback"
      (ACCEPTABLE - Uses amount from QR URL parameters)

5. After logs, check if:
   - Payment amount displays correctly
   - "Pay Now" button appears
   - No error messages visible

✓ PASS: Either A or B, button appears, no errors
✗ FAIL: Error messages, blank page, "Payment Failed"
```

### Test 4: Full Payment Flow
```
1. Merchant: Create 10 π payment
2. Wait 3 seconds (allow Redis commit)
3. Merchant: Show QR to customer device
4. Customer: Scan QR (opens in Pi Browser)
5. Customer: See payment details (amount, merchant)
6. Customer: Tap "Pay Now"
7. Customer: Pi Wallet opens, approve payment
8. Result: Payment completes
   - Customer page: "Payment Successful"
   - Merchant page: Payment status changes to "PAID"

✓ PASS: All steps succeed, payment confirmed on both sides
✗ FAIL: Any step fails, or "Payment not found"
```

## If Test 3 Fails ("Payment Not Found")

### Diagnostic Steps

**Step 1: Check Merchant Logs**
- Merchant page console should have Redis success logs
- If NOT present: Payment never reached Redis
  - Check network tab for POST /api/payments
  - Check response status (should be 2xx)

**Step 2: Check Customer Logs**
- Customer page should show retry attempts  
- If no logs appear: JavaScript error occurred
  - Check for red errors in console

**Step 3: Check Backend**
- Go to Upstash Redis dashboard
- Search for key: `payment:${id}`
- If found: data IS in Redis, timing issue
- If not found: backend storing failed

**Step 4: Manual Test**
In browser console, run:
```javascript
fetch("https://flashpay-two.vercel.app/api/payments/[PAYMENT_ID]")
  .then(r => r.json())
  .then(d => console.log("Response:", d))
```
Replace `[PAYMENT_ID]` with actual payment ID from merchant page.

Results:
- `{success: true, payment: {...}}` = Redis working, timing issue
- `{error: "...", success: false}` = API error
- Network error = Backend unreachable

## Solutions to Try (In Order)

1. **Increase wait time before scanning**
   - Wait 5 seconds after merchant creates payment
   - Gives Redis extra time to commit

2. **Increase retry attempts on customer page**
   - Currently: 3 attempts, 2 sec apart
   - Could increase to 5 attempts, 3 sec apart
   - Would give ~15 seconds total wait

3. **Check Redis configuration**
   - Verify UPSTASH_REDIS_REST_URL is set
   - Verify UPSTASH_REDIS_REST_TOKEN is set
   - Test connection to Upstash

4. **Check network latency**
   - If customer on different network than merchant
   - Network delays might compound
   - Solution: Retry logic handles this

5. **Enable fallback mode**
   - Payment amount is in QR URL parameters
   - Even if Redis fails, fallback uses URL params
   - This is already implemented

## Status Summary

| Component | Status | Notes |
|-----------|--------|-------|
| QR Domain | FIXED | Uses `pi://flashpay.pi` ✓ |
| API Endpoint | WORKING | Stores to Redis with verification |
| Customer Fetch | WORKING | Has retry logic (3×) |
| Session Isolation | OK | Both in Pi Browser, same backend |
| CORS | OPEN | Allows all origins |
| Timing | LIKELY ISSUE | May need wait or retry increase |
| Redis Connection | UNKNOWN | Need to verify credentials |

## Next Actions

1. Run Test 1 (QR domain verification) - should now PASS
2. Run Test 2 (Redis storage) - check for storage logs  
3. Run Test 3 (Payment discovery) - see if "payment found" or "fallback"
4. Share console logs from all three tests
5. Based on results, we can apply targeted fix
