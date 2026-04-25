# اختبار شامل لإصلاح Merchant Data

## الخطوات الأساسية قبل الاختبار

1. **افتح Brave (Pi Browser)**
2. **افتح Console**: F12 → Console tab
3. **امسح الـ logs القديمة**: اكتب `clear()` واضغط Enter

## Test Case 1: Flow كامل من Create إلى Pay

### الخطوة 1: إنشاء دفعة

1. اذهب إلى صفحة Create Payment
2. أدخل:
   - Amount: 10 Pi
   - Note: "Test payment"
3. اضغط "Create Payment"

### التحقق 1.1: الـ logs من CreatePayment

ابحث عن:
```
[Operations] ========================================
[Operations] CRITICAL: Extracting merchant data from payment store
[Operations] Merchant ID: merchant_177...
[Operations] Merchant Address: 788fda28-af7c-46a5-...
```

**سِج المقاطع:**
- merchantId الأصلي
- merchantAddress الأصلي
- Payment ID

### الخطوة 2: استدعاء executePayment

بعد نقرك "Pay Now"، ابحث عن:

```
[Operations] ========================================
[Operations] CRITICAL: Extracting merchant data from payment store
[Operations] Payment ID: payment_123...
[Operations] Merchant ID: merchant_177...
[Operations] Merchant Address: 788fda28-af7c-46a5-...
```

**✓ التحقق:** يجب أن تكون نفس القيم من الخطوة 1.1

### الخطوة 3: Pi SDK Logs

ابحث عن:
```
[Pi SDK] ========================================
[Pi SDK] CRITICAL: About to create Pi payment
[Pi SDK] Input merchantId: merchant_177...
[Pi SDK] Input merchantAddress: 788fda28-af7c-46a5-...
[Pi SDK] ========================================
```

**✓ التحقق:** نفس القيم من الخطوة 1.1

### الخطوة 4: Approval Callback

ابحث عن:
```
[Pi SDK] ========================================
[Pi SDK] onReadyForServerApproval CALLBACK TRIGGERED
[Pi SDK] Data being sent to backend:
[Pi SDK]   - merchantId: merchant_177...
[Pi SDK]   - merchantAddress: 788fda28-af7c-46a5-...
```

**✓ التحقق:** نفس القيم من الخطوة 1.1

---

## Test Case 2: Shared Link (السيناريو الحرج)

### الخطوة 1: إنشاء دفعة عادية

1. إذا كنت في صفحة Create، أنشئ دفعة جديدة
2. لاحظ Payment ID من الرابط: `/pay/payment_456`

### الخطوة 2: انسخ الرابط المشارك

في صفحة Pay، يجب أن ترى زر "Share Link"
انسخ الرابط الكامل

### الخطوة 3: افتح في نافذة جديدة

1. افتح نافذة جديدة في Brave
2. الصق الرابط
3. ستكون في صفحة Customer Payment View

### الخطوة 4: تتبع الـ logs

عند فتح الصفحة، ابحث عن:
```
[v0] ✅ Payment found from server: ...
[v0][CRITICAL] Server payment merchant data:
[v0][CRITICAL]   - merchantId: merchant_177...
[v0][CRITICAL]   - merchantAddress: 788fda28-af7c-46a5-...
```

**سِج هذه القيم - يجب أن تكون نفس التي من Scenario 1**

### الخطوة 5: اضغط "Pay Now"

تتبع الـ logs:

1. في `[UnifiedStore]`:
```
[UnifiedStore] ========================================
[UnifiedStore] CRITICAL: Creating payment with merchant data
[UnifiedStore] Input merchantId: merchant_177...
[UnifiedStore] Input merchantAddress: 788fda28-af7c-46a5-...
[UnifiedStore] Final merchantId selected: merchant_177...
[UnifiedStore] Final merchantAddress selected: 788fda28-af7c-46a5-...
```

2. في `[Pi SDK]`:
```
[Pi SDK] Input merchantId: merchant_177...
[Pi SDK] Input merchantAddress: 788fda28-af7c-46a5-...
```

**✓ التحقق الحاسم:** 
- merchantId يجب أن يكون **نفسه من الخطوة 2**
- ليس merchantId التاجر الحالي!
- merchantAddress يجب أن يكون **نفسه من الخطوة 2**
- ليس فارغ!

---

## Test Case 3: التدفق الكامل مع الموافقة

### الخطوة 1: من صفحة Pay، اضغط "Pay Now"

### الخطوة 2: تابع الـ logs

```
[Pi SDK] onReadyForServerApproval CALLBACK TRIGGERED
[Pi SDK] Approval payload being POSTed to /api/pi/approve:
{
  "identifier": "...",
  "amount": 10,
  "memo": "...",
  "metadata": {
    "paymentId": "payment_456",
    "merchantId": "merchant_177...",
    "merchantAddress": "788fda28..."
  }
}
```

**✓ التحقق:**
- metadata.merchantId ليس فارغ ✓
- metadata.merchantAddress ليس فارغ ✓
- متطابقين مع الدفعة الأصلية ✓

### الخطوة 3: تابع في Pi Browser

وافق على الدفع من محفظة Pi

### الخطوة 4: انتظر التأكيد

يجب أن ترى:
```
✓ Payment Successful
Transaction ID: ...
```

---

## Checklist النجاح

### ✅ Scenario 1 (Normal Create → Pay)

- [ ] merchantId متطابق في Operations
- [ ] merchantId متطابق في Pi SDK
- [ ] merchantAddress متطابق في Operations
- [ ] merchantAddress متطابق في Pi SDK
- [ ] metadata يُرسل بقيم صحيحة
- [ ] الدفع يكتمل بنجاح

### ✅ Scenario 2 (Shared Link)

- [ ] Payment محملة من السيرفر
- [ ] merchantId محفوظ من السيرفر
- [ ] merchantAddress محفوظ من السيرفر
- [ ] عند الموافقة، merchantId متطابق
- [ ] عند الموافقة، merchantAddress متطابق
- [ ] **IMPORTANT:** merchantId ليس merchantId التاجر الحالي

### ✅ Scenario 3 (Complete Flow)

- [ ] Approval يُرسل metadata صحيحة
- [ ] Backend يستقبل merchantId و merchantAddress
- [ ] الدفع يكتمل مع التحويل الصحيح

---

## الأخطاء الشائعة وحلولها

### ❌ خطأ 1: merchantAddress فارغ في logs

```
[Pi SDK] Input merchantAddress: ""
```

**السبب:** قد تكون قيمة fallback في unified-store

**الحل:** تحقق من أن createPaymentWithId يستخدم الشرط الجديد:
```typescript
merchantAddress !== undefined ? merchantAddress : ...
```

### ❌ خطأ 2: merchantId يتغير بين Steps

```
// الخطوة 1
merchantId: merchant_1777154251759_lvrls7qpa

// الخطوة 3
merchantId: merchant_1777153347027_7f0gte56w  ← WRONG!
```

**السبب:** fallback في unified-store يستخدم `this.state.merchant.merchantId`

**الحل:** تأكد من تطبيق الإصلاح في السطور 460-468 من unified-store.ts

### ❌ خطأ 3: Backend يستقبل قيم خاطئة

في `/api/pi/approve` logs:
```
"metadata": {
  "merchantId": "merchant_1777153347027_7f0gte56w",  ← DIFFERENT!
  "merchantAddress": ""  ← EMPTY!
}
```

**السبب:** البيانات تُفقد قبل الوصول إلى backend

**الحل:** تابع الـ logs في Pi SDK callback لترى ما يُرسل فعلياً

---

## خطوات Debug متقدمة

إذا استمرت المشكلة:

1. **في Console، شغّل هذا الكود:**

```javascript
// Print all [Pi SDK] logs
console.log("Filtering [Pi SDK] logs...")

// Also check stored payments
localStorage.getItem('flashpay_store')
```

2. **تفقد Redux/State:**

```javascript
// If you have access to store
window.__flashpay_store?.state?.payments[0]
```

3. **تفقد Network Request:**

في Network tab، اضغط على `/api/pi/approve` POST request
انظر إلى Request Body:
```json
{
  "metadata": {
    "merchantId": "?",
    "merchantAddress": "?"
  }
}
```

---

## ملاحظات مهمة

1. **جميع الـ logs تبدأ بـ bracket:**
   - `[Pi SDK]`
   - `[Operations]`
   - `[UnifiedStore]`
   - `[v0]`

2. **ابحث عن كلمات مفتاحية:**
   - `merchantId`
   - `merchantAddress`
   - `CRITICAL`
   - `========`

3. **الـ logs مرتبة زمنياً** - اتبعها من الأعلى إلى الأسفل

4. **احفظ صورة من الـ logs** عند كل اختبار للمقارنة

---

## متى تشاركني النتائج

شارك معي:

1. **جميع الـ logs من Console** (screenshot أو نص)
2. **Backend logs** من `/api/pi/approve` و `/api/pi/complete`
3. **أي رسائل خطأ** تظهر
4. **تسجيل:**
   - Payment ID المستخدم
   - merchantId المتوقع
   - merchantAddress المتوقع
   - merchantId الفعلي المُستقبل
   - merchantAddress الفعلي المُستقبل
