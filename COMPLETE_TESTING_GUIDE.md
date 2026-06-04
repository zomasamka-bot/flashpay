# FlashPay Payment System - Complete Testing Guide

## 🧪 Step-by-Step Payment Flow Testing

### PHASE 1: Environment Setup

**Requirements:**
\`\`\`
✅ Vercel Deployment Running
✅ Pi Developer Portal Configured (Testnet)
✅ Env Variables Set:
   - PI_API_KEY
   - UPSTASH_REDIS_REST_URL
   - UPSTASH_REDIS_REST_TOKEN
   - NEXT_PUBLIC_APP_URL
\`\`\`

**Verification:**
\`\`\`javascript
// In browser console
console.log(window.Pi ? "✅ Pi SDK Available" : "❌ Pi SDK Missing")
\`\`\`

---

### PHASE 2: MERCHANT AUTHENTICATION TEST

**Scenario:** Merchant logs in and authenticates with Pi Wallet

**Steps:**

1. Open app in Pi Browser
   \`\`\`
   URL: https://your-vercel-domain.vercel.app (or flashpay.pi if aliased)
   \`\`\`

2. Navigate to Home Page
   \`\`\`
   ✅ Should see "Authenticate" button
   ✅ Should show Testnet indicator
   \`\`\`

3. Click "Authenticate"
   \`\`\`
   ✅ Pi Wallet popup appears
   ✅ Requests scopes: username, payments, wallet_address
   \`\`\`

4. Grant Permissions in Pi Wallet
   \`\`\`
   ✅ Select User Account
   ✅ Accept Scopes
   ✅ Confirm
   \`\`\`

5. Wait for Redirect
   \`\`\`
   ✅ Should redirect to Home page
   ✅ Authentication panel should show username
   ✅ "Create Payment" button should be enabled
   \`\`\`

**Console Verification:**
\`\`\`javascript
// Open Console (F12) and check:
console.log("[AUTH-SUCCESS] Authentication complete. Username =", username)
console.log("[AUTH-VERIFY] storedUid from unifiedStore =", storedUid)

// Should see:
// [AUTH-SUCCESS] Authentication complete. Username = "merchant123"
// [AUTH-VERIFY] storedUid from unifiedStore = "user_abc123xyz"
\`\`\`

**Expected Result:**
\`\`\`
✅ Merchant authenticated
✅ Username stored: merchant123
✅ UID stored: user_abc123xyz (visible in console)
✅ Wallet address stored: 0x1234...
✅ Ready to create payments
\`\`\`

---

### PHASE 3: PAYMENT CREATION TEST

**Scenario:** Merchant creates a payment request

**Steps:**

1. Click "Create Payment"
   \`\`\`
   ✅ Should navigate to /create page
   ✅ Should show form with Amount and Note fields
   \`\`\`

2. Enter Payment Details
   \`\`\`
   Amount: 5
   Note: "Test payment for verification"
   \`\`\`

3. Click "Create Payment"
   \`\`\`
   ✅ Should show loading indicator
   ✅ Should not allow duplicate clicks
   \`\`\`

4. Wait for Success
   \`\`\`
   ✅ Toast notification: "Payment Created"
   ✅ Should show payment link and QR code
   ✅ Should copy link easily
   \`\`\`

**Console Verification:**
\`\`\`javascript
// Check API request logs:
console.log("[API] PAYMENT CREATION REQUEST RECEIVED")
console.log("[API] Extracted merchantId:", merchantId)
console.log("[API] Extracted merchantUid:", merchantUid)

// Check Redis verification:
console.log("[API] ✅ Redis.set() completed successfully for key:", kvKey)
console.log("[API] ✅ VERIFICATION AFTER REDIS RETRIEVAL:")
console.log("[API]   - Retrieved merchantUid:", storedData.merchantUid)
console.log("[API]   - Retrieved createdAt:", storedData.createdAt)

// Should NOT see errors about missing merchantId or merchantUid
\`\`\`

**Expected Result:**
\`\`\`
✅ Payment created successfully
✅ Payment ID: abc123def456
✅ Amount: 5 Pi
✅ Status: PENDING
✅ Stored in Redis with merchantUid
✅ Link ready to share
\`\`\`

---

### PHASE 4: PAYMENT LINK TEST

**Scenario:** Open payment link as if you're the customer

**Steps:**

1. Copy Payment Link
   \`\`\`
   Format: https://domain.vercel.app/pay/abc123def456
   \`\`\`

2. Open in Same Pi Browser (Different Session/Tab)
   \`\`\`
   ✅ Should show payment details
   ✅ Should show amount: 5 π
   ✅ Should show note: "Test payment for verification"
   ✅ Should show QR code
   ✅ Should show "Pay with Pi Wallet" button
   \`\`\`

3. Verify Payment Data Loaded
   \`\`\`
   ✅ Payment retrieved from Redis
   ✅ Amount matches: 5
   ✅ Status shows: PENDING
   \`\`\`

**Console Verification:**
\`\`\`javascript
// Check payment fetch:
console.log("[v0] Payment retrieved successfully:", payment)
console.log("[v0] Payment from server:")
console.log("[v0]   - ID:", payment.id)
console.log("[v0]   - Amount:", payment.amount)
console.log("[v0]   - Status:", payment.status)
console.log("[v0]   - merchantId:", payment.merchantId)
\`\`\`

**Expected Result:**
\`\`\`
✅ Payment page loads
✅ Shows correct amount and note
✅ Shows QR code
✅ "Pay with Pi Wallet" button enabled
✅ Pi SDK ready indicator shows
\`\`\`

---

### PHASE 5: PAYMENT EXECUTION TEST

**Scenario:** Customer completes payment

**Steps:**

1. Click "Pay with Pi Wallet"
   \`\`\`
   ✅ Should authenticate as customer (may use same account)
   ✅ Requests "payments" scope
   \`\`\`

2. Confirm Payment in Pi Wallet
   \`\`\`
   ✅ Pi Wallet popup shows
   ✅ Shows amount: 5 π
   ✅ Shows app wallet address
   ✅ User clicks "Confirm"
   \`\`\`

3. Wait for Blockchain Confirmation
   \`\`\`
   ✅ Status changes to "Confirming on blockchain..."
   ✅ Background polling starts (3-second intervals)
   ✅ Wait for blockchain confirmation (1-2 minutes)
   \`\`\`

4. Payment Complete
   \`\`\`
   ✅ Status changes to "Payment Submitted"
   ✅ Eventually: "Payment Successful"
   ✅ Shows transaction ID
   \`\`\`

**Console Verification:**
\`\`\`javascript
// Check Pi SDK flow:
console.log("[v0][Pi SDK] onReadyForServerApproval CALLBACK")
console.log("[v0][Pi SDK] Merchant data in callback - merchantId:", merchantId)

// Check completion:
console.log("[v0] ========== PAYMENT SUCCESS CALLBACK ==========")
console.log("[v0] Transaction ID:", txid)

// Check polling:
console.log("[v0] Polling payment status...")
console.log("[v0] Updated payment status:", updated.status)
console.log("[v0] ✅ Payment confirmed on blockchain!")
\`\`\`

**Expected Result:**
\`\`\`
✅ U2A payment initiated
✅ Payment marked PAID in Redis
✅ Transaction ID recorded
✅ Status updated to PAID
✅ Payment page shows completion
\`\`\`

---

### PHASE 6: MERCHANT FUND RECEIPT TEST

**Scenario:** Verify merchant received payment

**Steps:**

1. Check Backend Logs for A2U Initiation
   \`\`\`
   Look for: "[A2U-INIT] Starting A2U transfer"
   Should show: Merchant UID and amount
   \`\`\`

2. Check for A2U Endpoint Response
   \`\`\`
   Look for: "[A2U-INIT] A2U endpoint responded:"
   Should show: success = true
   \`\`\`

3. Verify Pi API Response
   \`\`\`
   Look for: "[Pi A2U] ✓ SUCCESS - A2U payment initiated"
   Should show: Pi payment identifier
   \`\`\`

4. Switch to Merchant's Pi Wallet
   \`\`\`
   ✅ Open Pi Wallet as merchant (same account from step 2)
   ✅ Check Transactions tab
   ✅ Look for new incoming transaction
   ✅ Should show: 5 π received from FlashPay
   \`\`\`

5. Verify Transaction Details
   \`\`\`
   ✅ Amount: 5 π
   ✅ From: FlashPay App
   ✅ Status: Completed
   ✅ Date: Recent (within minutes)
   \`\`\`

**Console Verification (Backend):**
\`\`\`javascript
// A2U Initiation:
console.log("[A2U-INIT] Starting A2U transfer")
console.log("[A2U-INIT] Merchant UID from Redis =", merchantUid)
console.log("[A2U-INIT] Amount to transfer =", amount, "Pi")

// A2U Request:
console.log("[Pi A2U] Creating A2U payment with Pi API")
console.log("[Pi A2U] Sending", amount, "Pi to user UID:", merchantUid)
console.log("[Pi A2U] ===== SENDING TO PI API =====")
console.log("[Pi A2U] payment.uid being sent:", uid)

// A2U Response:
console.log("[Pi A2U] ✓ SUCCESS - A2U payment initiated")
console.log("[Pi A2U] Pi payment identifier:", identifier)
console.log("[Pi A2U] Pi payment status:", status)
\`\`\`

**Expected Result:**
\`\`\`
✅ A2U transfer initiated successfully
✅ No errors in merchantUid handling
✅ Pi API accepted payment request
✅ Merchant receives funds in wallet
✅ Transaction visible in Pi Wallet
✅ Amount matches payment: 5 π
\`\`\`

---

### PHASE 7: PAYMENT STATUS VERIFICATION

**Scenario:** Verify all systems show payment as completed

**Steps:**

1. Reload Payment Page
   \`\`\`
   URL: https://domain.vercel.app/pay/abc123def456
   ✅ Should show "Payment Completed"
   ✅ Should display transaction ID
   ✅ Should lock "Pay" button
   \`\`\`

2. Check Payments List
   \`\`\`
   Go to: /payments
   ✅ Should show all payments
   ✅ Find test payment
   ✅ Should show status: PAID
   ✅ Should show amount: 5 π
   ✅ Should show transaction ID
   ✅ Should show timestamp
   \`\`\`

3. Check Redis Payment Object
   \`\`\`javascript
   // Simulate backend check:
   // Redis key: payment:abc123def456
   // Should contain:
   {
     "id": "abc123def456",
     "status": "paid",
     "txid": "0xabcdef...",
     "paidAt": "2026-05-11T10:05:30.000Z",
     "merchantUid": "user_abc123xyz"
   }
   \`\`\`

4. Verify Database Recording (if PostgreSQL configured)
   \`\`\`
   Check transaction_log table:
   ✅ Payment recorded with merchantId
   ✅ Amount matches
   ✅ Status: completed
   ✅ All timestamps present
   \`\`\`

**Expected Result:**
\`\`\`
✅ Payment shows as PAID everywhere
✅ Transaction ID recorded
✅ All timestamps correct
✅ No data loss in Redis
✅ All auditing complete
\`\`\`

---

## 🔍 DEBUGGING CHECKLIST

### If Merchant Can't Authenticate
\`\`\`
❌ Problem: Pi Wallet not showing
   ✅ Solution: 
      - Verify using Pi Browser
      - Check app domain registered in Portal
      - Check scopes: username, payments, wallet_address
      - Try app reload

❌ Problem: No UID in console
   ✅ Solution:
      - Check auth response has uid field
      - Check completeMerchantSetup() called
      - Check browser storage has uid
      - Try clearing localStorage and re-auth
\`\`\`

### If Payment Creation Fails
\`\`\`
❌ Problem: "Merchant UID is empty"
   ✅ Solution:
      - Authenticate first (Phase 2)
      - Verify uid in unifiedStore
      - Check merchant state in console:
         unifiedStore.state.merchant.uid

❌ Problem: "Invalid amount"
   ✅ Solution:
      - Enter positive number
      - Example: 5 or 5.5
      - Not: 0, -5, "abc"

❌ Problem: API error 500
   ✅ Solution:
      - Check Redis configured: isKvConfigured
      - Check UPSTASH env vars
      - Check Redis connection
      - Verify payment object serializable
\`\`\`

### If Payment Execution Fails
\`\`\`
❌ Problem: "Not in Pi Browser"
   ✅ Solution:
      - Use Pi Browser app
      - Not Safari/Chrome with fake Pi SDK
      - Must be actual Pi app

❌ Problem: "Payment already completed"
   ✅ Solution:
      - Payment can only be paid once
      - Check status in Redis
      - Use different payment ID for new payment

❌ Problem: "Authentication timeout"
   ✅ Solution:
      - Pi Wallet not responding
      - Check Testnet enabled on device
      - Try again after 30 seconds
      - Restart Pi Browser
\`\`\`

### If Merchant Doesn't Receive Funds
\`\`\`
❌ Problem: No A2U transfer initiated
   ✅ Solution:
      - Check backend logs for "[A2U-INIT]"
      - Verify merchantUid not empty
      - Check Pi API Key configured
      - Check A2U endpoint logs

❌ Problem: Pi API returned 404
   ✅ Solution:
      - merchantUid might be invalid
      - Verify UID format (string, 5-100 chars)
      - Check UID matches actual Pi user
      - Try with different account

❌ Problem: No transaction in merchant wallet
   ✅ Solution:
      - Wait 5-10 minutes for blockchain
      - Check using correct Pi Wallet account
      - Verify transaction status on Pi Network
      - Check wallet balance
\`\`\`

---

## ✅ FINAL VERIFICATION

### Complete System Check
\`\`\`
Before Deployment:
  ✅ ENV vars configured
  ✅ Pi Developer Portal updated
  ✅ Redis connected
  ✅ Vercel deployment live

After Deployment:
  ✅ Phase 1: Authentication works
  ✅ Phase 2: Payment creation works
  ✅ Phase 3: Payment link accessible
  ✅ Phase 4: Payment execution works
  ✅ Phase 5: A2U transfer works
  ✅ Phase 6: Merchant receives funds
  ✅ Phase 7: Status verification works

Ready for Production:
  ✅ All phases passed
  ✅ No data loss observed
  ✅ No authentication errors
  ✅ Funds flow correctly
  ✅ System stable
\`\`\`

---

**Test Duration:** ~10-15 minutes per full cycle  
**Success Rate:** Should be 100% if all fixes applied  
**Documentation:** Complete  
**Status:** ✅ READY TO TEST

---

**Next Action:** Follow Phase 1-7 in order, document results, verify success
