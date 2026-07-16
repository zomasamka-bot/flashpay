# FlashPay - UID Debug Guide

## Current Status
- Payment flow works 100% ✓
- Payment storage works ✓
- A2U endpoint is called ✓
- Pi API returns: `user_not_found` ❌

## Root Cause
The UID being sent to A2U is likely NOT the valid app-scoped UID from the current Pi.authenticate() session.

## Critical Flow to Verify

### 1. SDK Initialization & Authentication
\`\`\`
App Load → Pi SDK Init → SDK Ready → authenticateMerchant() called
\`\`\`

**What to check in console:**
\`\`\`
[v0] Initializing Pi SDK...
[v0] Pi SDK initialized successfully
[v0] SDK ready - calling authenticateMerchant() to get fresh UID from Pi.authenticate()
[v0] Pi.authenticate() completed
[v0] Username: [merchant_username]
[v0] UID captured: [should show UID value or ❌ EMPTY]
[v0] Merchant setup complete with UID: ✓ or ❌
\`\`\`

**If you see "❌ EMPTY":**
- The UID is not in `authResult.user.uid`
- Check what fields actually exist in the response

### 2. Payment Creation
\`\`\`
User enters amount → createPayment() → Check UID in store
\`\`\`

**What to check:**
\`\`\`
[v0] ✓ Payment creation - UID is valid: [first 10 chars of UID]...
\`\`\`

**If you see error instead:**
\`\`\`
[v0] ❌ PAYMENT CREATION BLOCKED: Merchant UID is empty
\`\`\`
- Go back to step 1 - UID was not captured from Pi.authenticate()

### 3. Payment Approval & Completion
- User approves in Pi Wallet
- Complete webhook receives payment
- A2U transfer initiated with merchantUid

### 4. A2U Call
**In A2U endpoint logs, check:**
\`\`\`
[Pi A2U] === UID VERIFICATION AT ENDPOINT ===
[Pi A2U] merchant Uid: [value]
[Pi A2U] === EXACT UID BEING SENT TO Pi API ===
[Pi A2U] recipient_uid: [value]
\`\`\`

**Then Pi API response:**
\`\`\`
[Pi A2U] Pi API Response Status: 200 ✓ (or 400/401/404)
\`\`\`

## Action Items

### To Debug Now:
1. Open app in Pi Browser
2. Check browser console for all `[v0]` logs
3. If UID shows as "❌ EMPTY", report what fields ARE in authResult.user
4. If UID shows correctly but A2U still fails, check A2U endpoint response status

### If UID is Empty:
The issue is that `authResult.user.uid` doesn't exist. We need to find which field actually contains the app-scoped UID from Pi SDK in Testnet.

### If UID is Present but A2U Fails:
Check if the UID format is correct (should be alphanumeric string, not a number or special characters).
