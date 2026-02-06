# Diagnostic Test Script

## Purpose
Identify why "Cannot create a payment without 'payments' scope" error occurs

## What to Check in Vercel Logs

When the customer clicks "Pay with Pi Wallet", look for these exact log sequences:

### 1. Payment Button Click (Should appear)
```
[v0][CustomerView] ========== PAYMENT BUTTON CLICKED ==========
[v0][CustomerView] - piSDKReady: true
[v0][CustomerView] - payment: {id: "...", amount: ...}
```

### 2. Authentication Attempt (Should appear)
```
[v0][CustomerView] Authenticating with 'payments' scope before payment...
[v0] Calling Pi.authenticate with scopes: ["payments"]
[v0] Calling Pi.authenticate with onIncompletePaymentFound callback
```

### 3. Authentication Result (Critical)
```
[v0] ========== AUTHENTICATION RESULT ==========
[v0] Full authResult object: {...}
[v0] authResult type: object
[v0] authResult.user: {...}
[v0] Scopes granted: ["..."]
[v0] Has 'payments' scope: true/false
```

### 4. Payment Execution (Should appear if auth succeeds)
```
[v0][CustomerView] ✅ Payments scope granted, executing payment...
[v0][CustomerView] Starting payment execution...
[v0] ========== createPiPayment CALLED ==========
```

## Key Questions

Based on the logs, answer these:

**Q1: Does "Authenticating with 'payments' scope before payment..." appear?**
- YES → Authentication is being attempted
- NO → The authenticate call isn't being reached

**Q2: Does "AUTHENTICATION RESULT" appear?**
- YES → Pi.authenticate() returned something
- NO → Pi.authenticate() is hanging/timing out

**Q3: What does "Scopes granted" show?**
- ["payments"] → Scope was granted correctly
- [] or undefined → Scope was NOT granted
- Missing → User closed popup without granting

**Q4: Does "Has 'payments' scope" show true?**
- true → My validation passed
- false → My validation correctly caught the missing scope
- Missing → Validation didn't run

**Q5: Does the error appear AFTER "createPiPayment CALLED"?**
- YES → The issue is in Pi.createPayment() itself
- NO → The issue is before createPayment is called

## Most Likely Scenarios

### Scenario A: Authentication popup isn't showing
**Logs would show:**
- "Authenticating with 'payments' scope..." appears
- "AUTHENTICATION RESULT" never appears OR shows timeout
- **Cause:** Pi SDK not triggering the authentication popup in PiNet

### Scenario B: User closing popup without granting
**Logs would show:**
- "Authenticating with 'payments' scope..." appears
- "AUTHENTICATION RESULT" shows authResult but with empty/missing scopes
- **Cause:** User dismissing the popup

### Scenario C: Scope granted but not recognized by createPayment
**Logs would show:**
- "Has 'payments' scope: true" appears
- "createPiPayment CALLED" appears
- Error happens inside Pi.createPayment()
- **Cause:** Pi SDK internal issue or session problem

## Action Based on Scenario

### If Scenario A (popup not showing):
- Issue: Pi.authenticate() isn't working in PiNet environment
- Solution: May need different authentication approach

### If Scenario B (user closing popup):
- Issue: User experience or popup visibility
- Solution: Better user guidance, retry mechanism

### If Scenario C (scope granted but createPayment fails):
- Issue: Scope isn't persisting or Pi SDK has a bug
- Solution: May need to pass scope token differently to createPayment

## Next Steps

1. Run one more test (no deploy needed)
2. Capture the FULL Vercel console log output
3. Share the log section from "PAYMENT BUTTON CLICKED" to the error
4. I will identify the exact scenario and provide the precise fix
