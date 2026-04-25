# 🧪 TESTING PROTOCOL - REAL TESTNET FLOW

## المتطلبات قبل الاختبار:

### ✅ Environment Configuration:
- [ ] UPSTASH_REDIS_REST_URL تم تعيينها
- [ ] UPSTASH_REDIS_REST_TOKEN تم تعيينها
- [ ] PI_API_KEY تم تعيينها
- [ ] APP_URL مضبوطة على `https://flashpay.pi` (أو dev URL)

### ✅ Pi Developer Portal:
- [ ] Application مسجل و Approved
- [ ] App Domain = `flashpay.pi`
- [ ] Scopes تشمل: `username`, `payments`
- [ ] Testnet environment مفعل
- [ ] API Key تم توليده

### ✅ Device:
- [ ] استخدام Pi Browser (Testnet)
- [ ] اتصال بـ Testnet Pi Network
- [ ] عميل الاختبار لديه حساب Pi Testnet

---

## Test Scenario 1: Data Integrity Test

**الهدف**: التحقق من عدم فقدان بيانات التاجر

### Step 1: Payment Creation
```
1. Open app in Pi Browser: https://flashpay.pi/create
2. Enter: Amount = 10 π
3. Enter: Note = "Test Payment 1"
4. Click: "Create Payment Request"
```

**Validation Point 1**: Check Browser Console
```javascript
// Should see in Network tab:
POST /api/payments
Request Body:
{
  "amount": 10,
  "note": "Test Payment 1",
  "merchantId": "merchant_1234567890_abcdef",
  "merchantAddress": "YOUR_MERCHANT_UID"  // ← CRITICAL
}

Response (201 Created):
{
  "success": true,
  "payment": {
    "id": "payment_1234567890",
    "merchantId": "merchant_1234567890_abcdef",
    "merchantAddress": "YOUR_MERCHANT_UID",  // ← CRITICAL
    "amount": 10,
    "note": "Test Payment 1",
    "status": "PENDING",
    "createdAt": "2024-XX-XXTXX:XX:XX.XXXZ"
  }
}
```

**Success Criteria**:
- ✅ merchantId in response
- ✅ merchantAddress in response
- ✅ Status 201 Created

**If Failed**: Check server logs for `[API] PAYMENT OBJECT CREATED` messages

---

### Step 2: Payment Retrieval
```
Save the payment ID from Step 1
Navigate to: https://flashpay.pi/pay/[payment_id]
```

**Validation Point 2**: Check Network Tab
```javascript
// Should see:
GET /api/payments?id=payment_1234567890
Status: 200 OK

Response:
{
  "success": true,
  "payment": {
    "id": "payment_1234567890",
    "merchantId": "merchant_1234567890_abcdef",  // ← MUST BE PRESENT
    "merchantAddress": "YOUR_MERCHANT_UID",     // ← MUST BE PRESENT
    "amount": 10,
    "note": "Test Payment 1",
    "status": "PENDING",
    "createdAt": "2024-XX-XXTXX:XX:XX.XXXZ"
  }
}
```

**Success Criteria**:
- ✅ merchantId present
- ✅ merchantAddress present
- ✅ All other fields intact
- ✅ Status 200 OK

**If Failed**: Check server logs for `[API] CRITICAL VALIDATION - RETRIEVED PAYMENT`

---

## Test Scenario 2: Payment Execution Flow

**الهدف**: اختبار مسار الدفع من البداية للنهاية

### Step 1: Open Payment Page
```
URL: https://flashpay.pi/pay/[payment_id]

Verify:
- Amount shown: 10 π
- Note shown: "Test Payment 1"
- "Pay Now" button visible
```

### Step 2: Click "Pay Now"
```
1. Click "Pay Now" button
2. Wait for Pi Wallet to open
3. If Pi Wallet doesn't open:
   - Check if Pi SDK initialized
   - Check browser console for errors
   - Verify app is approved in Developer Portal
```

**Validation Point 1**: Server Logs During Approval

After user selects amount in Pi Wallet, look for these logs:

```
[Pi Webhook] APPROVE called at 2024-XX-XXTXX:XX:XX.XXXZ

[Pi Webhook] Pi Payment ID: pi_payment_xxxxxxxxxxxx
[Pi Webhook] Our Payment ID: payment_1234567890
[Pi Webhook] Merchant ID from metadata: merchant_1234567890_abcdef
[Pi Webhook] Merchant Address from metadata: YOUR_MERCHANT_UID

[Pi Webhook] ========================================
[Pi Webhook] CRITICAL: CACHING MERCHANT METADATA
[Pi Webhook] Pi Payment ID (for caching): pi_payment_xxxxxxxxxxxx
[Pi Webhook] Merchant ID to cache: merchant_1234567890_abcdef
[Pi Webhook] Merchant Address to cache: YOUR_MERCHANT_UID
[Pi Webhook] ========================================

[Pi Webhook] ✅ Metadata cached successfully
[Pi Webhook]   - Cache Key: pi:metadata:pi_payment_xxxxxxxxxxxx
[Pi Webhook]   - merchantId: merchant_1234567890_abcdef
[Pi Webhook]   - merchantAddress: YOUR_MERCHANT_UID

[Pi Webhook] ✅ VERIFICATION: Metadata in cache has:
[Pi Webhook]   - merchantId: merchant_1234567890_abcdef
[Pi Webhook]   - merchantAddress: YOUR_MERCHANT_UID

[Pi Webhook] APPROVE completed in XXms
```

**Success Criteria**:
- ✅ APPROVE webhook called
- ✅ Merchant data extracted from metadata
- ✅ Metadata cached successfully
- ✅ Verification confirms cache contains both merchantId and merchantAddress

**If Failed**: 
- Check if `[Pi Webhook] ✅ Metadata cached successfully` is missing
- Check if `VERIFICATION: Metadata in cache has:` is missing
- Verify Redis is accessible

---

### Step 3: Approve in Pi Wallet

```
1. In Pi Wallet, click "Approve" or "Confirm"
2. Wait for transaction to complete
3. Browser should refresh or show completion screen
```

**Validation Point 2**: Server Logs During Completion

Look for these logs:

```
[Pi Webhook] COMPLETE called at 2024-XX-XXTXX:XX:XX.XXXZ

[Pi Webhook] Pi Payment ID: pi_payment_xxxxxxxxxxxx
[Pi Webhook] Txid: txid_xxxxxxxxxxxxxxxx
[Pi Webhook] Our Payment ID: payment_1234567890

[Pi Webhook] ========================================
[Pi Webhook] MERCHANT DATA RESOLUTION
[Pi Webhook] Source 1 - Cached metadata (pi:metadata:${piId}):
[Pi Webhook]   - merchantId: merchant_1234567890_abcdef  // ✅ RETRIEVED
[Pi Webhook]   - merchantAddress: YOUR_MERCHANT_UID     // ✅ RETRIEVED
[Pi Webhook] Source 2 - Redis payment object:
[Pi Webhook]   - merchantId: merchant_1234567890_abcdef
[Pi Webhook]   - merchantAddress: YOUR_MERCHANT_UID
[Pi Webhook] Source 3 - Pi metadata (usually empty):
[Pi Webhook]   - merchantId: undefined
[Pi Webhook]   - merchantAddress: undefined
[Pi Webhook] ========================================

[Pi Webhook] FINAL MERCHANT DATA SELECTION:
[Pi Webhook]   - merchantAddress from cache: YOUR_MERCHANT_UID ✅ USING THIS
[Pi Webhook]   - merchantAddress from payment: YOUR_MERCHANT_UID
[Pi Webhook]   - Final merchantAddress for transfer: YOUR_MERCHANT_UID

[Pi Webhook] ========================================

[Transfer] TRANSFER EXECUTION STARTED
[Transfer]   transferId: transaction_xxxxxxxxxxxx
[Transfer]   merchantAddress (uid): YOUR_MERCHANT_UID
[Transfer]   amount: 10
[Transfer]   memo: FlashPay payout
```

**Success Criteria**:
- ✅ COMPLETE webhook called
- ✅ Metadata retrieved from cache (Source 1)
- ✅ merchantAddress extracted successfully
- ✅ Transfer execution started with valid merchantAddress
- ✅ NO "Please login with Pi wallet first" error ❌

**If Failed**: 
- Check if `Source 1` metadata was retrieved
- Check if merchantAddress is empty or undefined
- Look for transfer errors in logs

---

## Test Scenario 3: Verify Final State

After payment completes:

### In Browser:
```
1. Check if page shows: "Payment completed" or "Success"
2. Check transaction ID displayed
3. Navigate to /payments
4. Verify payment status changed from PENDING to PAID
```

### In Server Logs:
```
Look for:
[Pi Webhook] ✓ TRANSFER SUCCESSFUL
[Transfer]   transferId: transaction_xxxxxxxxxxxx
[Transfer]   piPaymentId: pi_payment_xxxxxxxxxxxx
[Transfer]   amount: 10
[Transfer]   merchantAddress (uid): YOUR_MERCHANT_UID

✓ Payment marked as PAID in Redis
✓ Transaction recorded
```

**Success Criteria**:
- ✅ Payment status = PAID in system
- ✅ Transfer marked as completed
- ✅ Transaction recorded

---

## Troubleshooting Matrix:

### ❌ "Cannot create payment"
**Cause**: API error during creation
**Fix**:
1. Check Redis connection
2. Check merchantId is present
3. Review POST /api/payments response

### ❌ "Please login with Pi wallet first" (most common)
**Cause**: merchantAddress not available during transfer
**Fix**:
1. Verify metadata is cached in approval step
2. Verify metadata is retrieved in completion step
3. Check `[Pi Webhook] FINAL MERCHANT DATA SELECTION` logs
4. Ensure merchantAddress is not empty

### ❌ "Payment not found"
**Cause**: Redis lookup failed
**Fix**:
1. Verify Redis connection
2. Check payment:${id} key exists
3. Verify merchantId is present

### ❌ "Metadata not in cache"
**Cause**: Approval webhook didn't cache properly
**Fix**:
1. Check if /api/pi/approve was called
2. Look for cache write errors
3. Verify Redis write permissions

---

## Success Checklist:

- [ ] Step 1: Payment created with merchantId and merchantAddress
- [ ] Step 2: Payment retrieved with both fields present
- [ ] Step 3: Metadata cached during approval webhook
- [ ] Step 4: Metadata retrieved during completion webhook
- [ ] Step 5: Transfer executed successfully
- [ ] Step 6: NO "Please login" errors
- [ ] Step 7: Payment status = PAID
- [ ] Step 8: Transaction recorded

---

## Log Collection for Debugging:

If anything fails, collect:

1. **Browser Console Logs**
   - Open DevTools → Console
   - Look for any `[v0]` or `[v0] Error` messages
   - Screenshot the full console

2. **Network Tab**
   - Open DevTools → Network
   - Filter by: XHR
   - Check all API calls and responses
   - Screenshot failed requests

3. **Server Logs**
   - Search for: `[API]`, `[Pi Webhook]`, `[Transfer]`
   - Look for any `❌ CRITICAL` messages
   - Look for error timestamps
   - Copy full log sections

4. **Redis Debug** (if needed)
   - Check if `payment:${id}` exists
   - Check if `pi:metadata:${piId}` exists
   - Verify both contain merchantAddress

---

**Ready to test!** 🚀
