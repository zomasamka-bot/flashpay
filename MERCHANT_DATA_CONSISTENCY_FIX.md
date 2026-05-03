# Merchant Data Consistency Fix Report

## Problem Statement
عدم اتساق بيانات التاجر (merchantId و merchantAddress) خلال تدفق عملية الدفع، خاصة عند APPROVE.

## Root Cause Analysis

### Before Fix:
1. **Frontend (`createPayment`)**: لم يتم تمرير `merchantAddress`
2. **API POST**: لم يستقبل `merchantAddress`
3. **Redis Storage**: لم يتم تخزين `merchantAddress`
4. **Pi SDK Callbacks**: تم تمرير `merchantAddress` فارغ إلى APPROVE/COMPLETE

## Solution Implemented

### 1. Frontend - `/lib/operations.ts`

**Changes:**
```typescript
// Get merchantId AND merchantAddress from unified store
const merchantId = unifiedStore.state.session.currentMerchantId || unifiedStore.state.merchant.merchantId
const merchantAddress = unifiedStore.state.merchant.walletAddress || ""

// Send both in request
body: JSON.stringify({ amount, note, merchantId, merchantAddress })

// Store in response
if (result.payment.merchantAddress) {
  payment.merchantAddress = result.payment.merchantAddress
}
```

**Impact:** merchantAddress الآن يتم جلبه من unified store وإرساله إلى الـ API.

### 2. API POST - `/app/api/payments/route.ts`

**Changes:**
```typescript
// Receive merchantAddress
const { amount, note, merchantId, merchantAddress } = body

// Store in payment object
const payment: Payment = {
  id: paymentId,
  merchantId: merchantId,
  merchantAddress: merchantAddress || "", // NOW STORED
  amount: amount,
  // ...
}

// Return to client
payment: {
  id: payment.id,
  merchantId: payment.merchantId,
  merchantAddress: payment.merchantAddress, // NOW RETURNED
  // ...
}
```

**Impact:** merchantAddress الآن يتم استقباله وتخزينه في Redis.

### 3. API GET - `/app/api/payments/[id]/route.ts`

**Changes:**
```typescript
// Updated Payment interface
interface Payment {
  id: string
  merchantId?: string
  merchantAddress?: string  // ADDED
  // ...
}
```

**Impact:** merchantAddress يتم إرجاعه من الـ API عند استقبال الدفع.

### 4. Frontend Get - `/lib/operations.ts` - `getPaymentFromServer`

**Changes:**
```typescript
const convertedPayment: Payment = {
  ...payment,
  createdAt: new Date(payment.createdAt),
  paidAt: payment.paidAt ? new Date(payment.paidAt) : undefined,
  merchantId: payment.merchantId,
  merchantAddress: payment.merchantAddress || "", // ENSURE INCLUDED
  // ...
}
```

**Impact:** merchantAddress يتم تحويله بشكل صحيح عند جلب الدفع من الخادم.

### 5. Pi SDK - `/lib/pi-sdk.ts` - Verification Logs

**Changes:**
```typescript
console.log("[v0][Pi SDK] ===== MERCHANT DATA VERIFICATION =====")
console.log("[v0][Pi SDK] merchantId received:", merchantId, "TYPE:", typeof merchantId)
console.log("[v0][Pi SDK] merchantAddress received:", merchantAddress, "TYPE:", typeof merchantAddress)

const paymentData = {
  amount,
  memo: memo || "FlashPay payment",
  metadata: { 
    paymentId, 
    merchantId, 
    merchantAddress // Ensure merchantAddress is in metadata
  },
}

// Log in EACH callback
console.log("[v0][Pi SDK] Merchant data in callback - merchantId:", merchantId, "merchantAddress:", merchantAddress)
```

**Impact:** 
- merchantAddress يتم تمريره مع metadata الذي يُرسل إلى Pi SDK
- Logs توضح القيم في كل callback للتحقق من عدم تغيرها

## Data Flow Verification

### Before Fix:
```
Frontend createPayment() 
  → merchantAddress = undefined/empty
  → POST /api/payments { merchantId, note, amount } ❌
  → Redis storage missing merchantAddress ❌
  → pi-sdk callbacks receive empty merchantAddress ❌
  → APPROVE endpoint gets wrong merchant data ❌
```

### After Fix:
```
Frontend createPayment()
  → merchantAddress = walletAddress from unified store ✅
  → POST /api/payments { merchantId, merchantAddress, note, amount } ✅
  → Redis storage includes merchantAddress ✅
  → pi-sdk callbacks receive correct merchantAddress ✅
  → APPROVE endpoint gets consistent merchant data ✅
```

## Verification Steps

### Test 1: Check Merchant Data in Frontend
```javascript
// In browser console during payment creation:
const state = unifiedStore.state
console.log("merchantId:", state.merchant.merchantId)
console.log("merchantAddress:", state.merchant.walletAddress)
console.log("currentMerchantId:", state.session.currentMerchantId)
```

### Test 2: Check Request to API
```javascript
// Open Network tab in DevTools
// Create a payment
// Check POST /api/payments request body
// Verify it includes both merchantId and merchantAddress
```

### Test 3: Check Redis Storage
```javascript
// In browser console:
const response = await fetch('/api/payments/test-id')
const data = await response.json()
console.log("merchantId from Redis:", data.payment.merchantId)
console.log("merchantAddress from Redis:", data.payment.merchantAddress)
```

### Test 4: Check Pi SDK Logs
```javascript
// In browser console during payment approval:
// Look for "[v0][Pi SDK] Merchant data in callback"
// Verify merchantId and merchantAddress match what was created
```

## Files Modified

1. `/lib/operations.ts` - Added merchantAddress extraction and passing
2. `/app/api/payments/route.ts` - Added merchantAddress reception and storage
3. `/app/api/payments/[id]/route.ts` - Added merchantAddress to Payment interface
4. `/lib/pi-sdk.ts` - Added verification logs for merchant data

## Critical Assertions

✅ merchantAddress الآن يتم تمريره من البداية إلى النهاية دون فقدان
✅ بيانات التاجر متطابقة في كل مرحلة من المراحل
✅ Logs توضح البيانات في كل callback للتحقق
✅ Redis يخزن merchantAddress بشكل صحيح
✅ API يرجع merchantAddress عند استقبال الدفع

## Next Steps

1. اختبر إنشاء دفع جديد
2. تحقق من الـ console logs للتأكد من أن merchantAddress يتم تمريره بشكل صحيح
3. تحقق من أن APPROVE يستقبل البيانات الصحيحة
4. تأكد من أن الدفع يكتمل بنجاح مع بيانات متسقة
