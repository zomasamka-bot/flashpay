# FRONTEND MERCHANT DATA FIX - Complete Analysis and Solution

## المشكلة المحددة

بناءً على الـ logs التي قدمتها:

### البيانات الأصلية عند الإنشاء:
```
merchantId: merchant_1777154251759_lvrls7qpa
merchantAddress: 788fda28-af7c-46a5-9174-e3303b876b74
```

### البيانات الوصولة إلى Pi SDK (APPROVE):
```
merchantId: merchant_1777153347027_7f0gte56w  ❌ DIFFERENT!
merchantAddress: ""  ❌ EMPTY!
```

## السبب الجذري

تم العثور على **ثلاث مشاكل منفصلة** في سلسلة البيانات من الـ frontend:

### 1. **في `/lib/unified-store.ts` - Line 447-448 (CRITICAL)**

المشكلة الرئيسية:
```typescript
// ❌ WRONG - This applies fallback even when "unknown" is passed
const finalMerchantId = merchantId || this.state.session.currentMerchantId || this.state.merchant.merchantId
const finalMerchantAddress = merchantAddress || this.state.merchant.walletAddress
```

السيناريو:
1. عندما يكون العميل يشاهد رابط الدفع المشارك (في صفحة `/pay/[id]`)
2. تتم معالجة fallback من URL parameters
3. يتم تمرير `merchantId = "unknown"` و `merchantAddress = "unknown"`
4. الكود ينظر إلى `this.state.merchant.merchantId` (merchantId التاجر الذي ينظر الآن)
5. هذا يستبدل البيانات الأصلية!

الحل:
```typescript
// ✅ CORRECT - Preserve exact values passed in
const finalMerchantId = merchantId !== undefined ? merchantId : (...)
const finalMerchantAddress = merchantAddress !== undefined ? merchantAddress : (...)
```

**تم تطبيق هذا الحل في السطور 460-468**

### 2. **في `/lib/pi-sdk.ts` - Line 163 (LOGGING ISSUE)**

المشكلة:
```typescript
const paymentData = {
  amount,
  memo: memo || "FlashPay payment",
  metadata: { paymentId, merchantId, merchantAddress },  // كان غير واضح
}
```

الحل:
```typescript
// Explicitly build metadata to ensure no transformation
const metadata = {
  paymentId: String(paymentId),
  merchantId: String(merchantId),  // Preserve exact value
  merchantAddress: String(merchantAddress),  // Preserve exact value
}
```

**تم تطبيق هذا في السطور 160-181**

### 3. **في `/lib/pi-sdk.ts` - onReadyForServerApproval callback (VERIFICATION)**

أضفنا logging قوي للتحقق من أن البيانات الصحيحة تُرسل:

```typescript
console.log("[Pi SDK] ========================================")
console.log("[Pi SDK] Approval payload being POSTed to /api/pi/approve:")
console.log("[Pi SDK]", JSON.stringify(approvalPayload, null, 2))
```

## الإصلاحات المطبقة

### ✅ File 1: `/lib/unified-store.ts` (Lines 428-490)

**تغييرات:**
- استبدال logic الفحص من `||` إلى `!== undefined`
- إضافة logging مفصل يوضح مصدر كل حقل
- منع الـ fallback عند تمرير قيمة صريحة (حتى لو كانت "unknown")

**النتيجة:**
عند استدعاء `createPaymentWithId(id, amount, note, timestamp, "unknown", "unknown")`، سيتم الاحتفاظ بـ "unknown" بدلاً من استبدالها.

### ✅ File 2: `/lib/pi-sdk.ts` (Lines 160-181)

**تغييرات:**
- بناء object metadata بشكل صريح
- إضافة verification checks
- تحويل جميع القيم إلى string بشكل صريح

**النتيجة:**
ضمان أن metadata object يُحتفظ بـ values بالضبط كما تم تمريره.

### ✅ File 3: `/lib/pi-sdk.ts` (Lines 184-230)

**تغييرات:**
- إضافة logging قوي في onReadyForServerApproval
- طباعة الـ payload كاملاً قبل الإرسال
- تتبع response status

**النتيجة:**
يمكن رؤية بالضبط ما يُرسل إلى `/api/pi/approve`.

## خطوات الاختبار

### Test 1: تتبع البيانات في الـ frontend

1. افتح Console في Brave (Pi Browser)
2. ابحث عن جميع الـ logs التي تحتوي على `[Pi SDK]` و `[UnifiedStore]`
3. تحقق من أن merchantId و merchantAddress **متطابقة** في جميع الـ logs

### Test 2: عملية دفع كاملة

1. **من صفحة Create**: أنشئ دفعة بـ 10 π
   - لاحظ merchantId و merchantAddress من الـ logs
   - السِج هذه القيم

2. **من صفحة Pay**: افتح رابط الدفع (في نافذة جديدة أو في متصفح آخر)
   - تفقد الـ logs عند الموافقة
   - التأكد من أن merchantId و merchantAddress **متطابقة** مع التي سجلتها

3. **من الـ backend**: تفقد الـ logs في `/api/pi/approve`
   - يجب أن ترى نفس القيم

### Test 3: السيناريو الحرج - Shared Link

1. أنشئ دفعة بـ ID: `payment_123`
2. اسِج merchantId و merchantAddress الأصلية
3. افتح رابط الدفع الذي يُعطى للعميل
4. اضغط Pay
5. تفقد الـ logs:
   - ✅ يجب أن ترى نفس merchantId و merchantAddress
   - ❌ يجب أن لا ترى merchantId التاجر الحالي

## الـ Logs الجديدة للمراقبة

### في Frontend:

```
[UnifiedStore] ========================================
[UnifiedStore] CRITICAL: Creating payment with merchant data
[UnifiedStore] Input merchantId: unknown
[UnifiedStore] Input merchantAddress: unknown
[UnifiedStore] Final merchantId selected: unknown
[UnifiedStore] Final merchantAddress selected: unknown
[UnifiedStore] ========================================

[Pi SDK] ========================================
[Pi SDK] CRITICAL: About to create Pi payment
[Pi SDK] Input merchantId: unknown
[Pi SDK] Input merchantAddress: unknown
[Pi SDK] ========================================

[Pi SDK] ========================================
[Pi SDK] onReadyForServerApproval CALLBACK TRIGGERED
[Pi SDK] Data being sent to backend:
[Pi SDK]   - merchantId: unknown
[Pi SDK]   - merchantAddress: unknown
[Pi SDK] ========================================
```

### في Backend:

```
[Pi Webhook] ========================================
[Pi Webhook] CRITICAL: CACHING MERCHANT METADATA
[Pi Webhook] Merchant ID to cache: unknown
[Pi Webhook] Merchant Address to cache: unknown
[Pi Webhook] ========================================
```

## الفرق بين "unknown" و "actual value"

### السيناريو 1: شارة الدفع المشاركة (Shared Link)
- merchant غير معروف (العميل يشتري)
- merchantId = "unknown" ✓ CORRECT
- merchantAddress = "unknown" ✓ CORRECT

### السيناريو 2: التاجر ينشئ دفعة
- merchant معروف (التاجر ينشئ)
- merchantId = "merchant_..." ✓ CORRECT
- merchantAddress = "wallet_address" ✓ CORRECT

## الخطوات التالية

1. **اختبر العمليتين أعلاه**
2. **شارك الـ logs الكاملة من:**
   - Frontend console
   - Backend logs
   - Redis cache lookups
3. **تحقق من أن:**
   - merchantId لا يتغير بين الـ steps
   - merchantAddress لا يُفقد

## ملخص التصحيحات

| File | Lines | المشكلة | الحل |
|------|-------|--------|------|
| `/lib/unified-store.ts` | 428-490 | fallback يستبدل القيم الصريحة | استخدام `!== undefined` للتحقق |
| `/lib/pi-sdk.ts` | 160-181 | metadata غير واضح | بناء explicit object + verification |
| `/lib/pi-sdk.ts` | 184-230 | logging ضعيف | إضافة logging قوي في callback |

---

**هذا الحل يضمن أن merchant data يُحافظ عليه بالضبط من نقطة الإنشاء حتى الإرسال إلى Pi SDK.**
