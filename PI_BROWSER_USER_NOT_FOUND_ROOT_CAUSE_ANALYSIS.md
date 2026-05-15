# Pi Browser `user_not_found` Root Cause Analysis

## Current Status

✅ **Works in Developer Portal**: All A2U steps succeed (createPayment → sign → Horizon → complete → wallet)  
❌ **Fails in Pi Browser**: A2U createPayment returns `user_not_found` even though:
- /v2/me succeeds and returns valid UID
- UID format is correct (length 36, string, no spaces)
- Same UID is used in request
- U2A payment (reverse flow) works correctly

## Root Cause: APP CONTEXT MISMATCH

The evidence strongly points to an **app context/app_id mismatch** between:

1. **User Authentication Context (Pi Browser)**: User authenticated via `Pi.authenticate()` in their app
   - User gets UID that belongs to App ID X
   - User gets accessToken scoped to App ID X

2. **A2U API Context (Backend)**: A2U uses `PI_API_KEY` from environment
   - PI_API_KEY is registered to App ID Y
   - A2U createPayment API call is made in context of App ID Y

3. **Result**: UID from context X is not found in context Y → `user_not_found`

## Why This Doesn't Happen in Developer Portal

Developer Portal makes direct API calls using PI_API_KEY directly:
- All calls are in the context of App ID Y (PI_API_KEY's app)
- No intermediate user authentication needed
- So the UID works fine

## Why This ONLY Happens in Pi Browser

Pi Browser runs the app inside the Pi ecosystem:
- User authenticates to their app with `Pi.authenticate()`
- User context is scoped to that app's app_id
- But PI_API_KEY might belong to a different registered app

## The Complete UID Flow

### At Payment Creation (in Pi Browser):
```
1. Frontend: merchantUid = unifiedStore.state.merchant.uid  
   (obtained from Pi.authenticate() in Pi Browser context)

2. Frontend sends: POST /api/payments with merchantUid + accessToken
   (accessToken is from Pi.authenticate())

3. Backend verifies: /v2/me(accessToken) → returns user data
   (This works because accessToken is still valid)

4. Backend stores: 
   - payment.merchantUid = verified UID
   - payment.accessToken = accessToken
   (Stores in Redis for later A2U use)
```

### Later at A2U Settlement:
```
1. A2U retrieves: const payment = redis.get(paymentId)

2. A2U verifies: /v2/me(payment.accessToken)
   (This still works - accessToken is valid)

3. A2U sends to Pi: createPayment(
   apiKey: PI_API_KEY,
   uid: payment.merchantUid
)
   ❌ Pi rejects: "user_not_found"
   Reason: UID belongs to app context X, but PI_API_KEY is registered for app context Y
```

## Key Evidence

From the logs:

```
[Pi A2U] /v2/me verification SUCCEEDED
[Pi A2U] User app_id: [value shown or NOT PROVIDED]
[Pi A2U] Verified UID: [valid UID]
[Pi A2U] UIDs match: true

[Pi A2U] ❌ STEP 1: createPayment FAILED
[Pi A2U] Error: user_not_found
```

This proves:
1. UID exists and is valid ✅
2. UID is in correct format ✅
3. UID is being passed correctly ✅
4. BUT: UID doesn't exist in PI_API_KEY's app context ❌

## Solution Checklist for FlashPay Configuration

**To fix this issue, verify in Pi Developer Portal:**

- [ ] **App Registration**: Is FlashPay registered as a single app?
- [ ] **API Key Registration**: Is PI_API_KEY from the exact same app registration?
- [ ] **App URL Configuration**: Does the app_url match where Pi Browser loads the app from?
- [ ] **A2U Permissions**: Is App-to-User payment enabled for this app?
- [ ] **Environment Match**: Are both the app and PI_API_KEY on the same environment (testnet/mainnet)?

## How to Diagnose

The new logging will show:

**At payment creation:**
```
[v0] ===== PAYMENT CREATION - UID FLOW SUMMARY =====
[v0] Frontend Context: merchantUid = [UID from Pi.authenticate()]
[v0] Backend will: 1. Call /v2/me
                  2. Verify UID
                  3. Store in Redis
                  4. Include accessToken for A2U
```

**At A2U execution:**
```
[Pi A2U] ===== FRESH /V2/ME RESPONSE AT A2U TIME =====
[Pi A2U] Fresh /v2/me app_id: [shows app context of authenticated user]
[Pi A2U] Fresh /v2/me uid: [shows current valid UID]
[Pi A2U] NOTE: This is the CURRENT user context in Pi Browser at A2U execution time

[Pi A2U] ===== CRITICAL: UID STORED VS UID SENT TO A2U =====
[Pi A2U] If UIDs match but Pi still rejects:
   → Issue is NOT the UID itself
   → Issue IS the app context mismatch
```

## Next Steps

1. Check logs for the app_id shown in /v2/me response
2. Verify that PI_API_KEY is registered to the same app in Dev Portal
3. Confirm A2U is enabled for that app
4. If they don't match, register the correct API Key or update the app registration
5. Re-test the flow from Pi Browser
