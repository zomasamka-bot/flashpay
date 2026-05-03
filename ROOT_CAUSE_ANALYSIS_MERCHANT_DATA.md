# تحليل جذري لمشاكل بيانات التاجر

## الخلاصة الفورية:

**المشكلة ليست في تمرير البيانات، المشكلة في حساب `currentMerchantId` نفسه!**

---

## المشاكل المحددة:

### 1. ❌ merchantAddress يتم إرساله فارغ من البداية

**المصدر**: `/lib/operations.ts` السطر 64
```typescript
const merchantAddress = unifiedStore.state.merchant.walletAddress || ""
```

**المشكلة**: 
- في `/lib/pi-sdk.ts` السطر 439 نمرر `walletAddress` من `authResult.user.walletAddress`
- لكن في `completeMerchantSetup()` قد لا يتم تعيينها بشكل صحيح
- فتبقى `walletAddress` فارغة في `unifiedStore.state.merchant`

**الدليل**: في الـ logs: "merchantAddress فارغ"

---

### 2. ❌ merchantId يتغير بين مرحلة الإنشاء و APPROVE/COMPLETE

**المصدر**: `/lib/unified-store.ts` السطر 486 و 502

```typescript
// في getPayment() و getAllPayments():
const currentMerchantId = this.state.session.currentMerchantId || this.state.merchant.merchantId
```

**المشكلة**:
- عند إنشاء الدفع: `currentMerchantId = "user-123"`
- بعد refresh أو تغيير session: `currentMerchantId` قد يتغير!
- عند APPROVE: قد يكون `currentMerchantId = "user-456"` (مختلف!)
- النتيجة: الـ payment المخزن بـ merchantId "user-123" لا يُجد لأننا نبحث عن "user-456"

**المشكلة الحقيقية**: `currentMerchantId` قيمة **ديناميكية** وليست **ثابتة**!

---

### 3. ❌ Metadata القادمة من frontend لا تطابق بيانات الدفع الأصلية

**المصدر**: `/lib/pi-sdk.ts` السطر 159-163
```typescript
const paymentData = {
  amount,
  memo: memo || "FlashPay payment",
  metadata: { 
    paymentId,           // ✅ ثابت
    merchantId,          // ❌ قد يكون مختلف!
    merchantAddress      // ❌ قد يكون فارغ!
  },
}
```

**المشكلة**: 
- عند استدعاء `createPiPayment()` يتم تمرير `merchantId` و `merchantAddress`
- لكن هذه القيم تأتي من `payment` الذي جُلب من `unifiedStore`
- وفي `unifiedStore` قد تكون **مختلفة** عما تم حفظها في البداية!

---

### 4. ❌ النظام يعتمد على Redis لتعويض الخطأ

**المصدر**: `/app/api/payments/route.ts` و `/app/api/payments/[id]/route.ts`

**المشكلة**:
- عند الإنشاء نحفظ: `{ id, merchantId, merchantAddress, ... }`
- عند الـ APPROVE نجلب من Redis
- لكن البيانات المحفوظة **قد تكون خاطئة من البداية** (merchantId أو merchantAddress مختلفة)
- Redis لا يصلح الخطأ، فقط يحفظه!

---

### 5. ❌ Payment History لا تظهر العمليات (0 payments)

**المصدر**: `/lib/unified-store.ts` السطر 502-504
```typescript
getAllPayments(): Payment[] {
    const currentMerchantId = this.state.session.currentMerchantId || this.state.merchant.merchantId
    return [...this.state.payments]
      .filter((p) => p.merchantId === currentMerchantId)  // ❌ FILTER!
```

**المشكلة الحقيقية**:
- تم إنشاء payments بـ `merchantId = "user-123"`
- بعد refresh أو logout/login جديد: `currentMerchantId = "user-456"`
- الـ filter يرفضها لأن `"user-123" !== "user-456"`
- النتيجة: 0 payments تظهر!

**هذا هو سبب اختفاء جميع العمليات!**

---

## الحل الجذري المطلوب:

### 1. Fix walletAddress في completeMerchantSetup()
- تأكد أن `walletAddress` يُحفظ بشكل صحيح في الـ state

### 2. ✅ Fix merchantId ثابت
- يجب أن يكون `merchantId` **ثابت** طوال دورة حياة الـ payment
- لا يتغير بسبب تغير `currentMerchantId`

### 3. ✅ Fix payment retrieval
- عند جلب payment للـ APPROVE/COMPLETE، لا نستخدم `currentMerchantId`
- نجلبها من Redis مباشرة أو نستخدم merchantId المخزن في metadata

### 4. ✅ Fix getAllPayments()
- لا نستخدم filter بناءً على `currentMerchantId`
- نرجع جميع payments ثم نفلترها في الـ UI أو نستخدم merchantId من الـ payment نفسه

---

## الخطة الإصلاح:

1. ✅ التأكد من تمرير walletAddress بشكل صحيح في completeMerchantSetup()
2. ✅ عدم الاعتماد على currentMerchantId المتغير
3. ✅ استخدام merchantId المحفوظ في الـ payment كمصدر الحقيقة
4. ✅ تنظيف Filter في getAllPayments()
