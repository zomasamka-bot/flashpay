# Diagnostic Logs Guide - Payments Scope Issue

## Current Issue
Error: "Cannot create a payment without 'payments' scope"

## What to Check in Vercel Logs

### 1. **Page Load - Initial State**
Look for:
```
[v0][CustomerView] ========== RENDER STATE ==========
[v0][CustomerView] isPaid: false
[v0][CustomerView] piSDKReady: true/false
[v0][CustomerView] isAuthenticated: true/false  <-- KEY: Should be FALSE initially
[v0][CustomerView] authError: none
[v0][CustomerView] BUTTON VISIBILITY:
[v0][CustomerView] - Show 'Connect Pi Wallet': true/false
[v0][CustomerView] - Show 'Pay with Pi Wallet': true/false
```

**Expected:** Initially, isAuthenticated should be `false`, so "Connect Pi Wallet" should show.

---

### 2. **If Customer Clicks "Connect Pi Wallet"**
Look for:
```
[v0][CustomerView] ========== CONNECT WALLET CLICKED ==========
[v0][CustomerView] Calling authenticateCustomer() to request 'payments' scope...
```

Then in authenticate function:
```
[v0] Calling window.Pi.authenticate with scopes: ["payments"]
[v0] ========== AUTHENTICATION RESULT ==========
[v0] Full authResult object: {...}
[v0] authResult.user: {...}
[v0] Scopes granted: [...]  <-- KEY: Should include "payments"
[v0] Has 'payments' scope: true/false  <-- KEY: Should be TRUE
```

**Expected:** After clicking "Connect Pi Wallet", the Pi authentication dialog should appear to the customer, and if they approve, `Has 'payments' scope: true` should log.

---

### 3. **Authentication Success Path**
```
[v0][CustomerView] ✅ Authentication successful - payments scope granted
[v0][CustomerView] authenticateCustomer() result: {success: true}
```

**Then render state should update:**
```
[v0][CustomerView] isAuthenticated: true  <-- NOW TRUE
[v0][CustomerView] - Show 'Pay with Pi Wallet': true  <-- BUTTON APPEARS
```

---

### 4. **When Customer Clicks "Pay with Pi Wallet"**
```
[v0][CustomerView] ========== PAYMENT BUTTON CLICKED ==========
[v0][CustomerView] isAuthenticated: true  <-- Should be TRUE
[v0][CustomerView] ✅ Authentication verified, proceeding with payment...
[v0] ========== createPiPayment CALLED ==========
[v0] Pi SDK available, calling window.Pi.createPayment...
```

---

## Critical Diagnostic Questions

### Question 1: Does Customer See "Connect Pi Wallet" Button First?
- **YES:** Then customer must click it, see Pi authentication popup, and approve
- **NO (they see "Pay with Pi Wallet" immediately):** Then `isAuthenticated` is somehow `true` without authentication

### Question 2: What Shows in Authentication Result Logs?
Check for:
```
[v0] Scopes granted: [...]
```
- If this is **empty array `[]`**: Scope not granted by user
- If this is **missing/undefined**: Authentication response structure is wrong
- If this **includes "payments"**: Scope was properly granted

### Question 3: Does Pi Authentication Dialog Actually Appear to Customer?
When "Connect Pi Wallet" is clicked, the customer should see a Pi Browser popup asking to grant permissions. Does this happen?
- **YES, but customer dismisses it**: Would cause authentication to fail
- **YES, customer approves but doesn't see scope request**: Pi SDK might not be requesting scope properly
- **NO dialog appears**: Pi SDK authenticate() might not be working in PiNet

---

## Possible Root Causes

### A. Authentication Bypassed
If logs show `isAuthenticated: true` immediately without "CONNECT WALLET CLICKED" logs:
- **Cause:** State is being set to `true` somewhere else
- **Fix:** Find where `setIsAuthenticated(true)` is being called incorrectly

### B. Scope Not Requested Properly
If logs show authentication happens but `Scopes granted: []` is empty:
- **Cause:** Pi SDK `authenticate(["payments"])` not working in PiNet
- **Fix:** May need different API or Developer Portal configuration

### C. Scope Verification Failing
If logs show `Has 'payments' scope: false`:
- **Cause:** User dismissing popup OR Pi not prompting for scope
- **Fix:** Force user to grant scope before showing payment button

### D. Authentication Response Structure Wrong
If logs show `authResult.user.scopes` is undefined:
- **Cause:** Pi SDK returns different response structure in PiNet
- **Fix:** Adjust scope verification to match actual response format

---

## Next Steps

1. **Deploy current version** (with enhanced logging)
2. **Test and capture full Vercel logs** from page load through payment attempt
3. **Share the log output** focusing on the sections above
4. Based on logs, we can pinpoint the exact failure point

The logs will definitively show whether:
- Authentication is being called
- Scope is being requested
- Scope is being granted
- Button visibility logic is correct
