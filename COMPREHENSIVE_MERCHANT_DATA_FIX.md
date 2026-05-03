# تقرير شامل: حل مشاكل عدم اتساق بيانات التاجر

**التاريخ**: 1 مايو 2026  
**الحالة**: تم حل جميع المشاكل الثلاث بدقة ✅

---

## المشاكل الثلاث التي تم تحديدها والحل

### المشكلة 1: تغيير merchantId أثناء عملية الدفع ❌ → ✅

**المشكلة الأصلية**:
- merchantId كان يتغير بين مراحل الدفع (CREATE → APPROVE → COMPLETE)

**السبب الجذري**:
- `currentMerchantId` قد لا يكون مهيأً بشكل صحيح عند البداية
- استخدام منطق بديل غير متسق: `session.currentMerchantId || merchant.merchantId`

**الحل المطبق**:
- في `/lib/operations.ts` السطر 63: تثبيت جلب merchantId من مصدر واحد موثوق
- في `/lib/unified-store.ts` السطر 775: تأكيد تعيين `currentMerchantId` عند إكمال إعداد التاجر
- Verification logs لتتبع القيمة عبر جميع المراحل

**الملف**: `/lib/operations.ts` و `/lib/unified-store.ts`

---

### المشكلة 2: إرسال Metadata بشكل غير صحيح من الفرونت ❌ → ✅

**المشكلة الأصلية**:
- `merchantAddress` لم يكن يُرسل في POST request إلى `/api/payments`
- Metadata لم تكن تحتوي على `merchantAddress`

**السبب الجذري**:
- في `/lib/operations.ts` السطر 63 الأصلي: لم نكن نجلب `merchantAddress` من unified store
- لم نكن نمرره في JSON body

**الحل المطبق**:
1. **جلب البيانات**: استخراج `merchantAddress` من `unifiedStore.state.merchant.walletAddress`
2. **تمرير إلى API**: تضمين `merchantAddress` في POST request
   ```typescript
   body: JSON.stringify({ amount, note, merchantId, merchantAddress })
   ```
3. **التحقق**: Verification logs في `/lib/operations.ts` السطر 66-81

**الملفات**: 
- `/lib/operations.ts` - جلب وتمرير البيانات
- `/app/api/payments/route.ts` - استقبال وتخزين البيانات

---

### المشكلة 3: merchantAddress فارغ داخل Metadata ❌ → ✅

**المشكلة الأصلية الحرجة**:
- `walletAddress` كان فارغاً في `unifiedStore.state.merchant` 
- السبب: في `/lib/pi-sdk.ts` السطر 432، عند استدعاء `completeMerchantSetup()`، لم نكن نمرر `walletAddress`

```typescript
// قبل (خاطئ):
unifiedStore.completeMerchantSetup(authResult.user.username)

// بعد (صحيح):
unifiedStore.completeMerchantSetup(authResult.user.username, authResult.user.walletAddress)
```

**السبب الجذري**:
- `authResult.user.walletAddress` كان يحتوي على القيمة من Pi SDK
- لم يتم تمريره إلى الدالة `completeMerchantSetup()`
- بقي `merchant.walletAddress` دائماً `undefined`

**الحل المطبق**:
1. **جلب من Pi SDK**: استخراج `walletAddress` من `authResult.user.walletAddress`
2. **تمرير إلى الدالة**: 
   ```typescript
   unifiedStore.completeMerchantSetup(authResult.user.username, authResult.user.walletAddress)
   ```
3. **تخزين في State**: في `/lib/unified-store.ts` السطر 771:
   ```typescript
   this.state.merchant = {
     ...this.state.merchant,
     isSetupComplete: true,
     piUsername,
     walletAddress,  // ✅ الآن يتم تخزينه بشكل صحيح
     connectedAt: new Date(),
   }
   ```
4. **Verification logs**: في `/lib/pi-sdk.ts` السطر 430-447
   - تسجيل `authResult.user.walletAddress` من Pi SDK
   - تسجيل المعاملات عند استدعاء `completeMerchantSetup`

**الملفات**:
- `/lib/pi-sdk.ts` - جلب وتمرير `walletAddress` من auth result
- `/lib/unified-store.ts` - تخزين في state

---

## تدفق البيانات الصحيح الآن

```
┌─────────────────────────────────────────────────────────────┐
│ 1. AUTH PHASE (Pi SDK Authentication)                      │
├─────────────────────────────────────────────────────────────┤
│ authResult.user.username → completeMerchantSetup() ✅       │
│ authResult.user.walletAddress → completeMerchantSetup() ✅  │
│ ↓                                                           │
│ unifiedStore.state.merchant.walletAddress = stored ✅       │
│ unifiedStore.state.session.currentMerchantId = set ✅       │
└─────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. PAYMENT CREATION (Frontend → Backend)                    │
├─────────────────────────────────────────────────────────────┤
│ createPayment() reads from unified store:                   │
│   - merchantId = session.currentMerchantId ✅                │
│   - merchantAddress = merchant.walletAddress ✅              │
│ ↓                                                           │
│ POST /api/payments {                                        │
│   amount, note,                                             │
│   merchantId,        ✅ extracted from store               │
│   merchantAddress    ✅ extracted from store               │
│ }                                                           │
│ ↓                                                           │
│ Redis storage with both fields persisted ✅                 │
│ Response includes both fields ✅                             │
└─────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. PAYMENT EXECUTION (Frontend → Pi SDK)                    │
├─────────────────────────────────────────────────────────────┤
│ createPiPayment(                                            │
│   amount,                                                   │
│   memo,                                                     │
│   paymentId,                                                │
│   merchantId,         ✅ same from creation                │
│   merchantAddress,    ✅ same from creation                │
│   ...                                                       │
│ )                                                           │
│ ↓                                                           │
│ metadata = {                                                │
│   paymentId,                                                │
│   merchantId,         ✅ unchanged                          │
│   merchantAddress     ✅ unchanged                          │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. PAYMENT APPROVAL (Pi Wallet → Backend)                   │
├─────────────────────────────────────────────────────────────┤
│ onReadyForServerApproval callback                           │
│ metadata.merchantId ✅ = original value                      │
│ metadata.merchantAddress ✅ = original value                │
│ ↓                                                           │
│ POST /api/pi/approve with metadata ✅                       │
└─────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. PAYMENT COMPLETION (Pi Wallet → Backend)                 │
├─────────────────────────────────────────────────────────────┤
│ onReadyForServerCompletion callback                         │
│ metadata.merchantId ✅ = original value                      │
│ metadata.merchantAddress ✅ = original value                │
│ txid = verified from Pi blockchain ✅                        │
│ ↓                                                           │
│ POST /api/pi/complete with:                                 │
│   - metadata (unchanged) ✅                                  │
│   - transaction { txid, verified: true } ✅                 │
└─────────────────────────────────────────────────────────────┘
```

---

## الملفات المعدلة

### 1. `/lib/pi-sdk.ts` - المصدر الأساسي للبيانات
**الأسطر 430-447**: 
- جلب `authResult.user.walletAddress` من Pi SDK
- تمرير إلى `completeMerchantSetup()` مع username
- Verification logs لتتبع القيمة

### 2. `/lib/unified-store.ts` - تخزين البيانات
**السطور التالية**:
- 764-779: دالة `completeMerchantSetup()` تخزن walletAddress بشكل صحيح
- 440: إضافة `merchantAddress` في `createPaymentWithId()`
- 451: تسجيل verification logs

### 3. `/lib/operations.ts` - تمرير البيانات إلى API
**الأسطر 63-81**:
- جلب merchantAddress من `unifiedStore.state.merchant.walletAddress`
- تمرير في POST request إلى `/api/payments`
- Verification logs للتحقق من الصحة

### 4. `/app/api/payments/route.ts` - استقبال وتخزين
**التحديثات**:
- استقبال `merchantAddress` من request body
- تخزينه في Redis مع البيانات الأخرى
- إرجاعه في response

### 5. `/app/api/payments/[id]/route.ts` - إرجاع البيانات
**التحديثات**:
- إضافة `merchantAddress` إلى Payment interface
- التأكد من إرجاعه مع البيانات الأخرى

---

## التأثير على الاستقرار

### ✅ لا يوجد تأثير سلبي على الاستقرار
1. **الإصلاحات additive**: لم نحذف أي منطق موجود
2. **التوافقية العكسية**: الكود الحالي يعمل بدون الـ walletAddress
3. **Verification logs فقط**: logs لا تؤثر على المنطق
4. **نفس الـ API signature**: لم نغير طريقة استدعاء الدوال

### ✅ تحسينات الاستقرار
1. **Warnings واضحة**: إذا كان merchantAddress فارغاً
2. **Logs تفصيلية**: تساعد في debugging
3. **Verification checks**: تتأكد من تخزين البيانات بشكل صحيح

---

## اختبار الإصلاح

لتتأكد من أن الحل يعمل بشكل صحيح:

### 1. في وحدة التحكم (Console)
```javascript
// ستشاهد logs مثل هذا:
[v0][Pi SDK Auth] ===== AUTH RESULT DEBUG =====
[v0][Pi SDK Auth] authResult.user.username: testuser
[v0][Pi SDK Auth] authResult.user.walletAddress: pi1234567890
[v0][Pi SDK Auth] ==============================

[v0][createPayment] ===== MERCHANT DATA CHECK =====
[v0][createPayment] merchantId: merchant_123_abc TYPE: string
[v0][createPayment] merchantAddress: pi1234567890 TYPE: string
[v0][createPayment] ================================

[v0][createPaymentWithId] Creating payment with:
[v0][createPaymentWithId]   - id: abc-123
[v0][createPaymentWithId]   - merchantId: merchant_123_abc
[v0][createPaymentWithId]   - merchantAddress: pi1234567890
```

### 2. في Redux DevTools (if available)
```json
{
  "merchant": {
    "isSetupComplete": true,
    "merchantId": "merchant_123_abc",
    "piUsername": "testuser",
    "walletAddress": "pi1234567890",  ✅ Not empty!
    "connectedAt": "2026-05-01T..."
  }
}
```

### 3. التحقق من API Response
```json
{
  "success": true,
  "payment": {
    "id": "abc-123",
    "merchantId": "merchant_123_abc",
    "merchantAddress": "pi1234567890",  ✅ Not empty!
    "amount": 10,
    "note": "Test payment",
    "status": "PENDING",
    "createdAt": "2026-05-01T..."
  }
}
```

---

## الخلاصة

**تم حل جميع المشاكل الثلاث بدقة**:
1. ✅ merchantId لا يتغير - يتم جلبه من مصدر واحد موثوق
2. ✅ Metadata يُرسل بشكل صحيح - يتضمن merchantAddress من البداية
3. ✅ merchantAddress لا يكون فارغاً - يتم تمريره من Pi SDK Auth

**لا يوجد تأثير على الاستقرار** - الإصلاحات additive وتوافق عكسي كامل

**Verification logs تساعد في:**
- تتبع تدفق البيانات
- اكتشاف أي مشاكل في المستقبل
- التأكد من عدم حدوث المشاكل نفسها مجدداً
