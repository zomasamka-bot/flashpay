# Payment Not Found - Debugging Guide

## Current Issue

**Symptoms:**
- QR code opens correctly in Pi Browser ✅
- Customer sees: "Authentication Required - scope information is missing" ❌
- Then: "Payment Not Found" ❌
- Vercel logs show: `GET /api/payments → 404` and `[API] Payment not found` ❌

## Root Causes

### 1. **Vercel KV Not Configured (Most Likely)**

The payment is created in one serverless function instance but the GET request hits a different instance. Without Vercel KV, the in-memory storage doesn't persist across instances.

**Check:**
```bash
# In Vercel Dashboard → Your Project → Storage
# Verify that a KV database is created and linked
```

**Environment Variables Required:**
```
KV_REST_API_URL=https://...
KV_REST_API_TOKEN=...
```

### 2. **Payment Creation May Be Failing**

The merchant might see "payment created" but it's not actually persisting to storage.

**Check Merchant-Side Logs:**
```
[v0] ===== PAYMENT CREATION START =====
[v0] ===== PAYMENT CREATION SUCCESS =====
[API] ✅ Payment stored in Vercel KV
```

### 3. **Wrong API Endpoint Being Called**

The GET request might not include the payment ID in the URL path.

**Expected URL:**
```
GET /api/payments/{id}     ← Correct
GET /api/payments?id={id}  ← Wrong
GET /api/payments          ← Wrong (404)
```

## Debugging Steps

### Step 1: Check Vercel Logs During Payment Creation

When merchant creates payment, check logs for:

```
[API] Storage mode: Vercel KV  ← Should be "Vercel KV", not "In-Memory"
[API] ✅ Payment stored in Vercel KV: {id}
[API] Verification read: SUCCESS
```

If you see:
```
[API] ⚠️ Storing to in-memory (WILL NOT PERSIST)...
```

**This means KV is not configured!**

### Step 2: Check Vercel Logs When Customer Scans QR

When customer opens payment page:

```
[v0] ========== getPaymentFromServer START ==========
[v0] Full API URL: https://flashpay-two.vercel.app/api/payments/{id}
[v0] Response status: 200  ← Should be 200, not 404
[API][ID] Looking up payment: {id}
[API][ID] KV result: FOUND  ← Should be "FOUND", not "NOT FOUND"
```

### Step 3: Verify Payment ID Consistency

Check that the same ID is used throughout:

```
Merchant creates → Payment ID: abc-123
QR code contains → .../pay/abc-123
Customer opens  → paymentId: abc-123
API lookup      → /api/payments/abc-123
```

### Step 4: Test API Directly

Try calling the API manually right after creating a payment:

```bash
# Get payment ID from merchant's screen after creation
# Then immediately:
curl https://flashpay-two.vercel.app/api/payments/{PAYMENT_ID}
```

Should return:
```json
{
  "success": true,
  "payment": { "id": "...", "amount": 3, ... }
}
```

If it returns 404, KV is not working.

## Solutions

### Solution 1: Configure Vercel KV (Required for Production)

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your project `flashpay-two`
3. Go to **Storage** tab
4. Click **Create Database**
5. Select **KV (Redis)**
6. Name it (e.g., `flashpay-kv`)
7. Click **Create**
8. Go to **Settings** → **Environment Variables**
9. Verify these are set:
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
10. **Redeploy** the application

### Solution 2: Add Console Logging (Temporary)

The latest update added extensive logging to trace the entire flow.

**What to look for:**

1. When merchant creates payment:
   ```
   [v0] ===== PAYMENT CREATION SUCCESS =====
   [API] ✅ Payment stored in Vercel KV: {id}
   ```

2. When customer opens payment page:
   ```
   [v0][PaymentPage] Payment ID from URL path: {id}
   [v0] ========== getPaymentFromServer START ==========
   [v0] Full API URL: https://flashpay-two.vercel.app/api/payments/{id}
   [v0] Response status: 200
   [v0] ✅ Payment found in local storage: {id}
   ```

3. When customer clicks Pay:
   ```
   [v0] ========== STARTING AUTHENTICATION ==========
   [v0] ✅ Payments scope confirmed
   [v0] ========== Pi SDK: onReadyForServerApproval ==========
   ```

## Expected Flow

```
1. Merchant creates payment
   ↓
2. Payment stored in KV with ID: abc-123
   ↓
3. QR code generated with: pi://flashpay-two.vercel.app/pay/abc-123
   ↓
4. Customer scans QR → Opens in Pi Browser
   ↓
5. Page loads at /pay/abc-123
   ↓
6. Client calls GET /api/payments/abc-123
   ↓
7. API fetches from KV → Returns payment data
   ↓
8. Payment displays (3 π - Pending)
   ↓
9. Customer clicks "Pay with Pi Wallet"
   ↓
10. Pi SDK authenticates with "payments" scope
   ↓
11. Pi.createPayment() called → Wallet opens
   ↓
12. Customer approves → Transaction completes
   ↓
13. onSuccess callback → Status updates to PAID
```

## Next Steps

1. **Configure Vercel KV** (if not already done)
2. **Redeploy** to Vercel
3. **Test full flow** and check logs at each step
4. **Share Vercel logs** from both merchant creation and customer payment attempt

The extensive logging added in this update will help identify exactly where the flow breaks.
