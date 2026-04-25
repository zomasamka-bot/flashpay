# Critical QR Flow - Diagnosis and Fix

## Issues Identified

### Issue 1: QR Code Domain (FIXED)
- **Problem**: QR was using Vercel domain instead of Pi domain
- **Status**: FIXED - Now uses `pi://flashpay.pi/pay/{id}`

### Issue 2: "Payment Not Found" Error
When customer scans QR and opens payment page:
1. Merchant created payment on flashpay.pi (Pi Browser)
2. Payment was sent to Vercel API backend and stored in Redis
3. Customer opens payment from QR link (`pi://flashpay.pi/pay/{id}`)
4. Customer page fetches from `/api/payments/{id}` 
5. ERROR: "Payment not found"

## Root Causes Analysis

### Possible Cause 1: Timing Issue
- Customer scans QR **immediately** after merchant creates it
- Payment API response returned to client, but Redis write might be async
- Customer fetch happens before Redis commit completes

**Solution**: Add small delay in client before showing QR, or add retry logic on customer side (already exists - 3 attempts with 2sec delays)

### Possible Cause 2: Session/Domain Isolation
- Merchant session is isolated in Pi Browser session
- Customer session is different Pi Browser session
- But both should access same Vercel backend + Redis

**Verification**: Check browser console logs when customer opens payment page

### Possible Cause 3: API Fetch Failure
- Customer fetch to `/api/payments/{id}?` might be failing silently
- Could be CORS issue (though CORS is open)
- Could be Redis connection issue

**Verification**: Check `/app/pay/[id]/payment-content-with-id.tsx` diagnostic logs

## Step-by-Step Testing Protocol

### Test Scenario 1: Immediate QR Scan
```
1. Open app in Pi Browser as merchant
2. Create payment (10 π)
3. WAIT 5 SECONDS (allow Redis to commit)
4. Scan QR immediately
5. Check if payment loads
6. Check browser console for errors
7. Check merchant QR page console for logs
```

### Test Scenario 2: Check Redis Storage
```
1. In merchant console, after payment creation, look for:
   "[API] ✅ Redis.set() completed successfully"
   "[API] ✅ VERIFICATION AFTER REDIS RETRIEVAL"

2. These logs confirm payment IS in Redis

3. Then scan QR and check customer page console
```

### Test Scenario 3: Manual API Check
```
1. In browser console, run:
   fetch("https://flashpay-two.vercel.app/api/payments/PAYMENT_ID")
     .then(r => r.json())
     .then(d => console.log(d))

2. Replace PAYMENT_ID with actual payment ID from merchant page

3. Check if payment returns successfully
```

## Key Logs to Check

### On Merchant Page (When Creating Payment)
Look for:
```
[API] ✅ Redis.set() completed successfully
[API] ✅ VERIFICATION AFTER REDIS RETRIEVAL:
[API]   - merchantId: [should show merchant ID]
[API]   - merchantAddress: [should show address or undefined]
[API]   - createdAt: [should show ISO timestamp]
```

### On Customer Page (When Opening Payment)
Look for:
```
[v0] ⚠️ Fetching payment: [paymentId]
[v0] Attempt 1/3 to fetch payment
[v0] ✅ Payment found from server: [payment details]
OR
[v0] ✅ Payment retrieved successfully
```

If these logs say "Payment retrieved successfully" but you see "Payment Failed", it means:
- Payment WAS fetched
- But something failed during rendering or payment processing
- Check further logs for executePayment() errors

## If Still Failing

1. **Check merchant console after payment creation**
   - Look for Redis storage confirmation
   - If missing, payment was never stored

2. **Check customer page console**
   - Look for fetch attempt logs
   - If "Attempt 3 failed", API call is failing
   - Check exact error message

3. **Enable Pi Browser Developer Tools**
   - Right-click in Pi Browser → Inspect Element
   - Check Network tab for API call to `/api/payments/{id}`
   - Check response status code and body

4. **Common Issues**
   - Status 404 = Payment not in Redis (timing issue, wait longer before scanning)
   - Status 500 = Backend error (check Redis configuration)
   - No response = Network issue (unlikely if merchant page works)

## Solution If Timing Issue Confirmed

If problem is that customer scans too fast before Redis commit:

Option A: Add delay on merchant page before showing QR
```javascript
// Wait 2 seconds before showing QR to ensure Redis commit
await new Promise(r => setTimeout(r, 2000))
```

Option B: Improve customer page retry logic (already has 3 attempts)
```
- Current: 3 attempts, 2 sec delay between = ~6 seconds total
- Should be sufficient for most Redis commits
```

Option C: Store payment in localStorage immediately (not recommended, but fallback)
```javascript
// Client-side storage in unified-store
// Already implemented - if Redis fails, fallback to local store
```

## Next Steps

1. Run Test Scenario 1 exactly as described
2. Share all console logs from both merchant and customer pages
3. If you see the specific error, we can target fix immediately
