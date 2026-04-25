# MERCHANT DATA FLOW DEBUGGING CHECKLIST

## 🔍 Debug Steps to Verify Merchant Data Persistence

### Step 1: Payment Creation (Browser Console)
```javascript
// In Create Payment Page (/create)
// After clicking "Create Payment"

// Open DevTools → Console
// Check:
console.log("[DEBUG] Payment ID:", paymentId)  // Should exist
console.log("[DEBUG] Merchant ID:", merchantId)  // Should exist
console.log("[DEBUG] Merchant Address:", merchantAddress)  // Should exist
```

**Expected**: All three values should be logged

---

### Step 2: Check Redis Storage via API
```bash
# After payment creation, check Redis directly:

# Option 1: Via browser
fetch('http://localhost:3000/api/payments?id=YOUR_PAYMENT_ID')
  .then(r => r.json())
  .then(data => {
    console.log("[DEBUG] Payment from Redis:")
    console.log("  - id:", data.payment.id)
    console.log("  - merchantId:", data.payment.merchantId)
    console.log("  - merchantAddress:", data.payment.merchantAddress)
    console.log("  - amount:", data.payment.amount)
    console.log("  - createdAt:", data.payment.createdAt)
  })
```

**Expected Output**:
```
[DEBUG] Payment from Redis:
  - id: payment_1234567890
  - merchantId: merchant_xxxx
  - merchantAddress: MERCHANT_UID_HERE
  - amount: 10
  - createdAt: 2024-XX-XXTXX:XX:XX.XXXZ
```

---

### Step 3: Open Payment Page (/pay/[id])
```javascript
// In /pay/[id] page
// Check Network tab:
// GET /api/payments?id=YOUR_PAYMENT_ID
// 
// Expected Response:
{
  "success": true,
  "payment": {
    "id": "payment_123",
    "merchantId": "merchant_xxx",  // ← MUST be present
    "merchantAddress": "YOUR_UID",  // ← MUST be present
    "amount": 10,
    "note": "Test",
    "status": "PENDING",
    "createdAt": "2024-..."
  }
}
```

**Critical Check**: If `merchantId` or `merchantAddress` are missing in the response, the system will fail later.

---

### Step 4: Customer Clicks "Pay Now" Button
```javascript
// Pi SDK calls window.Pi.createPayment()
// Check Network tab:
//
// Request to /api/pi/approve should show in logs:
// [Pi Webhook] APPROVE called at TIMESTAMP
// [Pi Webhook] Pi Payment ID: pi_identifier_xxx
// [Pi Webhook] Our Payment ID: payment_123
// [Pi Webhook] Merchant ID from metadata: merchant_xxx
// [Pi Webhook] Merchant Address from metadata: YOUR_UID
```

**Critical Check**: Both merchant ID and address should be in logs.

---

### Step 5: Verify Metadata Cache (After Approve Webhook)
```javascript
// The approval webhook should cache metadata in Redis
// Check server logs for:
//
// [Pi Webhook] ✅ Metadata cached successfully
// [Pi Webhook]   - Cache Key: pi:metadata:${piPaymentId}
// [Pi Webhook]   - merchantId: merchant_xxx
// [Pi Webhook]   - merchantAddress: YOUR_UID
// [Pi Webhook] ✅ VERIFICATION: Metadata in cache has:
// [Pi Webhook]   - merchantId: merchant_xxx
// [Pi Webhook]   - merchantAddress: YOUR_UID
```

**Critical Check**: If metadata is NOT cached, the system will fail in the complete step.

---

### Step 6: Customer Approves in Pi Wallet
```javascript
// Pi SDK calls onReadyForServerCompletion callback
// Check server logs for:
//
// [Pi Webhook] COMPLETE called at TIMESTAMP
// [Pi Webhook] ✅ Retrieved server-side metadata from cache
// [Pi Webhook]   - cache key: pi:metadata:${piId}
// [Pi Webhook]   - merchantId: merchant_xxx
// [Pi Webhook]   - merchantAddress: YOUR_UID
```

**Critical Check**: If metadata is NOT retrieved, transfer will fail.

---

### Step 7: Transfer Execution
```javascript
// Check for transfer logs:
//
// [Transfer] TRANSFER EXECUTION STARTED
// [Transfer]   transferId: transaction_xxx
// [Transfer]   merchantAddress (uid): YOUR_UID
// [Transfer]   amount: 10
// [Transfer] ========================================
// [Transfer] STEP 1: Creating A2U payment...
```

**Critical Check**: merchantAddress MUST be present. If it shows empty or undefined, transfer will fail.

---

## ❌ Common Failures and What They Mean

### "Please login with Pi wallet first"
**Cause**: Transfer failed because merchantAddress is empty
**Check**: 
- Is merchantAddress present in payment object?
- Is metadata cached in Redis?
- Is metadata being retrieved in /api/pi/complete?

### "No merchant address found"
**Cause**: Both cache and payment object missing merchantAddress
**Check**:
- Was merchantAddress passed during payment creation?
- Did /api/pi/approve successfully cache it?
- Did /api/pi/complete successfully retrieve it?

### "Cannot determine merchant"
**Cause**: merchantId is missing
**Check**:
- Was merchantId passed during payment creation?
- Is it in Redis payment object?
- Is it in cached metadata?

---

## 🧪 Quick Test Flow

1. **Create Payment**
   - Input: Amount 10, Note "Test"
   - Check: Redis has merchantId + merchantAddress ✓

2. **Open /pay/[id]**
   - Check: API response includes merchantId + merchantAddress ✓

3. **Click Pay Now**
   - Check: Server logs show metadata cached ✓

4. **Approve in Wallet**
   - Check: Server logs show metadata retrieved ✓

5. **Transfer Executes**
   - Check: No "Please login" error ✓

---

## 📊 Log File Locations (Server Logs)

Look for these patterns in server console/logs:

| Pattern | File | Stage |
|---------|------|-------|
| `[API] PAYMENT CREATED WITH REQUIRED FIELDS` | `/api/payments/route.ts` | Creation |
| `[API] CRITICAL VALIDATION - RETRIEVED PAYMENT` | `/api/payments/route.ts` | Retrieval |
| `[Pi Webhook] ✅ Metadata cached successfully` | `/api/pi/approve/route.ts` | Approval |
| `[Pi Webhook] ✅ Retrieved server-side metadata from cache` | `/api/pi/complete/route.ts` | Completion |
| `[Transfer] TRANSFER EXECUTION STARTED` | `/lib/transfer-service.ts` | Transfer |

---

## 🔧 If Something Fails

1. **Collect all console logs** (both browser and server)
2. **Take screenshot of Network tab** (showing API requests/responses)
3. **Check Redis directly**:
   - Does `payment:${id}` exist with merchantId and merchantAddress?
   - Does `pi:metadata:${piId}` exist with both fields?
4. **Cross-reference logs** with steps above to find where data is lost
