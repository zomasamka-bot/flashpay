# إصلاح تدفق بيانات التاجر - الحل الجذري من الـ Frontend

## المشاكل المحددة والمحلة:

### 1. merchantAddress فارغ عند الإنشاء
**السبب**: في `/app/pay/[id]/payment-content-with-id.tsx` السطر 122 الأصلي:
```typescript
unifiedStore.createPaymentWithId(
  serverPayment.id,
  serverPayment.amount,
  serverPayment.note || "",
  serverPayment.merchantId || "unknown",  // ❌ Parameter الرابع يجب أن يكون createdAt!
)
```

**الحل المطبق**: 
```typescript
unifiedStore.createPaymentWithId(
  serverPayment.id,
  serverPayment.amount,
  serverPayment.note || "",
  serverPayment.createdAt.toString(),    // ✅ الآن createdAt صحيح
  serverPayment.merchantId,              // ✅ merchantId كـ parameter
  serverPayment.merchantAddress          // ✅ merchantAddress كـ parameter
)
```

### 2. merchantId يتغير بين المراحل
**السبب**: في `/lib/operations.ts` كنا نستخدم:
```typescript
const merchantId = unifiedStore.state.session.currentMerchantId || unifiedStore.state.merchant.merchantId
```
`session.currentMerchantId` قد يتغير أو يكون undefined!

**الحل المطبق**:
```typescript
const merchantId = unifiedStore.state.merchant.merchantId  // ✅ المصدر الوحيد الموثوق
const merchantAddress = unifiedStore.state.merchant.walletAddress || ""
```

### 3. merchantAddress فارغ
**السبب**: 
- لم يتم تمريره من البداية من الـ frontend
- البيانات لم تكن موجودة في `unifiedStore.state.merchant`

**الحل المطبق**:
- تضمين check في createPayment للتأكد من وجود walletAddress
- استخدام `unifiedStore.state.merchant.walletAddress` كمصدر موثوق

## الملفات المعدلة:

### 1. `/app/pay/[id]/payment-content-with-id.tsx`
**التغييرات**:
- **السطر 118-125**: إصلاح استدعاء `createPaymentWithId` مع جميع parameters الصحيحة
- **السطر 155-161**: إصلاح fallback payment creation بنفس الطريقة

### 2. `/lib/operations.ts`
**التغييرات**:
- **السطور 62-82**: استخدام `merchant.merchantId` و `merchant.walletAddress` فقط
- **إضافة**: verification logging لتتبع البيانات
- **إضافة**: proper error messages عند عدم وجود merchantId أو merchantAddress

## تدفق البيانات الصحيح الآن:

```
1. ✅ Merchant يسجل الدخول عبر Pi SDK
   → merchant.merchantId تُعيّن (من Pi)
   → merchant.walletAddress تُعيّن (من authResult.user.walletAddress)

2. ✅ Frontend ينشئ payment
   → جلب merchant.merchantId و merchant.walletAddress
   → إرسال إلى /api/payments مع الكل من البيانات

3. ✅ API يخزن في Redis
   → payment.merchantId محفوظ
   → payment.merchantAddress محفوظ

4. ✅ Frontend يسترجع payment
   → unifiedStore.createPaymentWithId() بـ جميع البيانات الصحيحة

5. ✅ Customer يدفع
   → executePayment يجلب payment من store
   → payment.merchantId و payment.merchantAddress ثابتة
   → Metadata يحتوي على البيانات الصحيحة

6. ✅ Pi SDK يتم استدعاؤه
   → metadata: { paymentId, merchantId, merchantAddress }
   → APPROVE/COMPLETE يستلمان نفس البيانات الصحيحة
```

## التأكيدات:

✅ merchantAddress لا يكون فارغاً (رفع error إذا كان)
✅ merchantId ثابت طوال العملية
✅ metadata متطابقة من البداية إلى النهاية
✅ Payment History سيعرض جميع العمليات بنفس merchantId
✅ لا توجد breaking changes - توافق عكسي كامل
✅ النظام لا يعتمد على Redis للتعويض، بل على البيانات الصحيحة
