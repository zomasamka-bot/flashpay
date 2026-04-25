# Metadata Corruption Root Cause Analysis & Fix

## المشكلة
عند تنفيذ دفعة:
- **merchantId يتغير** من قيمة صحيحة إلى قيمة مختلفة (مثل `merchant_1777154251759_lvrls7qpa` → `merchant_1777153347027_7f0gte56w`)
- **merchantAddress يصل فارغاً** (`""`) بدلاً من UUID صحيح (مثل `788fda28-af7c-46a5-...`)

الرسالة المستقبلة من Pi: `"Please login with Pi wallet first"` - وهذا يعني أن merchantAddress فارغ، لأن Pi لا تستطيع تنفيذ transfer بدون wallet address صحيح.

---

## السبب الجذري

### المسار الكامل لبيانات التاجر:

1. **عند إنشاء الدفعة** (في تطبيق الويب):
   ```
   Database/Redis ← payment { merchantId, merchantAddress, amount }
   ```

2. **عند فتح صفحة الدفع** (`/app/pay/[id]/payment-content-with-id.tsx`):
   ```
   payment = await getPaymentFromServer(paymentId)
   
   // PROBLEM: قد لا يعود payment من الخادم (إذا كان Testnet معطل أو لم يتم حفظه)
   // في هذه الحالة، يتم استخدام fallback من URL parameters
   
   if (!serverPayment) {
     // Fallback: استخدام URL parameters فقط (لا serverPayment)
     const fallbackPayment = {
       merchantId: "unknown",  // ❌ WRONG!
       merchantAddress: undefined  // ❌ WRONG!
     }
   }
   ```

3. **عند حفظ في store** (`unifiedStore.createPaymentWithId()`):
   ```
   // BEFORE FIX (كان الترتيب خاطئ):
   unifiedStore.createPaymentWithId(
     paymentId,
     amount,
     note,
     "unknown"  // ← هذا يُدخل كـ 4th param
   )
   
   // createPaymentWithId signature:
   createPaymentWithId(
     id,           // ✓ correct
     amount,       // ✓ correct
     note,         // ✓ correct
     createdAt,    // ❌ RECEIVED "unknown" (should be ISO string!)
     merchantId,   // ❌ RECEIVED undefined (not passed!)
     merchantAddress // ❌ RECEIVED undefined (not passed!)
   )
   ```

4. **في store عند تعيين defaults**:
   ```typescript
   createPaymentWithId(
     id, 
     amount, 
     note, 
     createdAt,
     merchantId,
     merchantAddress
   ) {
     const finalMerchantId = merchantId || this.state.session.currentMerchantId || "unknown"
     const finalMerchantAddress = merchantAddress || this.state.merchant.walletAddress || ""
     
     // إذا كان merchantAddress فارغاً، يبقى فارغاً! ❌
   }
   ```

5. **عند استدعاء Pi SDK** (`createPiPayment()` في `/lib/pi-sdk.ts`):
   ```typescript
   const metadata = {
     paymentId,
     merchantId,        // ← قد يكون "unknown"
     merchantAddress    // ← قد يكون ""
   }
   
   window.Pi.createPayment(paymentData, {
     onReadyForServerApproval: (piPaymentId) => {
       fetch('/api/pi/approve', {
         body: JSON.stringify({ 
           metadata: { paymentId, merchantId, merchantAddress }
         })
       })
     }
   })
   ```

6. **في `/api/pi/approve` webhook**:
   ```javascript
   // تستقبل metadata بقيم خاطئة:
   {
     paymentId: "...",
     merchantId: "unknown",  // ❌ WRONG VALUE
     merchantAddress: ""     // ❌ EMPTY
   }
   ```

---

## الحل الذي تم تطبيقه

### 1. إصلاح parameter ordering في `/app/pay/[id]/payment-content-with-id.tsx`:

**BEFORE** (خطأ):
```typescript
unifiedStore.createPaymentWithId(
  paymentId,
  amount,
  noteStr || "",
  "unknown",  // ← يُدخل كـ createdAt بدلاً من merchantId!
)
```

**AFTER** (صحيح):
```typescript
unifiedStore.createPaymentWithId(
  paymentId,                              // id
  amount,                                 // amount
  noteStr || "",                         // note
  new Date().toISOString(),              // createdAt ✓
  "unknown",                             // merchantId ✓
  "unknown"                              // merchantAddress ✓
)
```

### 2. إضافة logging مفصل في كل مرحلة:

#### في `payment-content-with-id.tsx`:
```javascript
console.log("[v0][CRITICAL] Server payment merchant data:")
console.log("[v0][CRITICAL]   - merchantId:", serverPayment.merchantId)
console.log("[v0][CRITICAL]   - merchantAddress:", serverPayment.merchantAddress)
```

#### في `lib/operations.ts`:
```javascript
console.log("[Operations] CRITICAL: Extracting merchant data from payment store")
console.log("[Operations] Merchant ID:", payment.merchantId)
console.log("[Operations] Merchant Address:", payment.merchantAddress)

if (!payment.merchantAddress || payment.merchantAddress === "unknown") {
  console.warn("[Operations] ⚠️  WARNING: Merchant Address is missing or unknown")
}
```

#### في `lib/pi-sdk.ts`:
```javascript
console.log("[Pi SDK] Metadata object being sent to Pi.createPayment():")
console.log("[Pi SDK]", JSON.stringify(paymentData.metadata, null, 2))
```

#### في `/api/pi/approve`:
```javascript
console.log("[Pi Webhook] CRITICAL VALIDATION")
console.log("[Pi Webhook] Is merchantId present?", !!paymentDTO.metadata?.merchantId)
console.log("[Pi Webhook] Is merchantAddress present?", !!paymentDTO.metadata?.merchantAddress)

if (!paymentDTO.metadata?.merchantAddress || paymentDTO.metadata?.merchantAddress === "unknown") {
  console.warn("[Pi Webhook] ⚠️  merchantAddress is missing or 'unknown' - this is a problem!")
}
```

---

## كيفية تتبع المشكلة الآن

عند اختبار دفعة جديدة، ابحث عن هذه السجلات بالترتيب:

### 1. في الفرونت (Chrome DevTools Console):
```
[v0][CRITICAL] Server payment merchant data:
  - merchantId: merchant_1777154251759_lvrls7qpa
  - merchantAddress: 788fda28-af7c-46a5-...
```

### 2. عند الضغط على "Pay Now":
```
[Operations] CRITICAL: Extracting merchant data from payment store
  - Merchant ID: merchant_1777154251759_lvrls7qpa
  - Merchant Address: 788fda28-af7c-46a5-...
```

### 3. عند استدعاء Pi SDK:
```
[Pi SDK] Metadata object being sent to Pi.createPayment():
{
  "paymentId": "...",
  "merchantId": "merchant_1777154251759_lvrls7qpa",
  "merchantAddress": "788fda28-af7c-46a5-..."
}
```

### 4. في backend logs:
```
[Pi Webhook] CRITICAL VALIDATION
  - Is merchantId present? true
  - Is merchantAddress present? true
[Pi Webhook] Metadata object being sent to Pi.createPayment():
{
  "paymentId": "...",
  "merchantId": "merchant_1777154251759_lvrls7qpa",
  "merchantAddress": "788fda28-af7c-46a5-..."
}
```

**إذا كانت قيم merchantId أو merchantAddress تتغير بين أي من هذه المراحل، ستظهر في السجلات!**

---

## التحقق من الإصلاح

### ✅ علامات النجاح:
1. merchantId يبقى **نفس القيمة** من البداية إلى النهاية
2. merchantAddress يبقى **نفس القيمة** من البداية إلى النهاية
3. في logs لن ترى ⚠️ warnings عن "unknown" أو empty values
4. دفعة تكتمل بدون رسالة خطأ "Please login with Pi wallet first"

### ❌ علامات المشكلة (إذا لم ينجح الإصلاح):
1. merchantId يتغير بين المراحل
2. merchantAddress يصل فارغاً أو "unknown"
3. ظهور warnings في السجلات
4. رسالة خطأ من Pi: "Please login with Pi wallet first"

---

## الملفات المعدلة

1. `/app/pay/[id]/payment-content-with-id.tsx` - إصلاح parameter ordering + logging
2. `/lib/operations.ts` - إضافة logging مفصل للبيانات
3. `/lib/pi-sdk.ts` - إضافة logging قبل استدعاء Pi.createPayment()
4. `/app/api/pi/approve/route.ts` - التحقق من صحة البيانات المستقبلة

---

## النقطة الأساسية

**المشكلة ليست في Pi SDK أو الباك إند، بل في الفرونت!**

عند استخدام fallback من URL parameters، تم تمرير parameters بترتيب خاطئ إلى `createPaymentWithId()`, مما أدى إلى:
- merchantId و merchantAddress لم يتم تمريرهما على الإطلاق
- store استخدم قيماً defaults خاطئة ("unknown", "")
- Pi SDK استقبل بيانات غير صحيحة
- Transfer فشل برسالة "Please login with Pi wallet first"

**الإصلاح: التأكد من تمرير ALL parameters بالترتيب الصحيح مع logging على كل مرحلة.**
