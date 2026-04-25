# Frontend Metadata Flow - Step-by-Step Debugging

## خطوات الاختبار

### الخطوة 1: إنشاء دفعة من التطبيق
1. افتح `/create`
2. أدخل مبلغ (مثل 10 π)
3. أدخل note (اختياري)
4. اضغط "Create Payment"

**في console ابحث عن:**
```
[v0] Payment created successfully
[v0] Payment ID: <ID>
[v0] Merchant ID: merchant_1777...
```

### الخطوة 2: افتح صفحة الدفع
1. انسخ Payment ID من الخطوة السابقة
2. افتح `/pay/<ID>`
3. **في Chrome DevTools Console ابحث عن:**

```
[v0][PaymentPage] ========== PAYMENT PAGE COMPONENT LOADED ==========
[v0][PaymentPage] Payment ID from URL path: <ID>

[v0] ✅ Payment found from server: {
  id: "...",
  amount: 10,
  merchantId: "merchant_1777154251759_lvrls7qpa",  ← اكتب هذا
  merchantAddress: "788fda28-af7c-46a5-...",       ← اكتب هذا
  status: "PENDING",
  ...
}

[v0][CRITICAL] Server payment merchant data:
  - merchantId: merchant_1777154251759_lvrls7qpa
  - merchantAddress: 788fda28-af7c-46a5-...
```

**✅ إذا شفت merchantId و merchantAddress، دوّن القيم:**
- merchantId: `_______________________`
- merchantAddress: `_______________________`

### الخطوة 3: اضغط "Pay Now" في الفرونت
1. اضغط زر "Pay Now"
2. اختر الحساب في محفظة Pi
3. **في console ابحث عن:**

```
[Operations] ========================================
[Operations] CRITICAL: Extracting merchant data from payment store
[Operations] Payment ID: <ID>
[Operations] Amount: 10
[Operations] Note: ...
[Operations] Merchant ID: merchant_1777154251759_lvrls7qpa
[Operations] Merchant Address: 788fda28-af7c-46a5-...
[Operations] ========================================
```

**✅ تحقق أن القيم **نفسها** من الخطوة 2:**
- merchantId: هل زي `merchant_1777154251759_lvrls7qpa`؟ ✓ / ✗
- merchantAddress: هل زي `788fda28-af7c-46a5-...`؟ ✓ / ✗

---

## Backend Logs (في Terminal أو Vercel Logs)

بعد ما تضغط "Pay Now" وتسمح في Pi Wallet، ابحث عن هذه السجلات:

### في `/api/pi/approve` webhook:

```
[Pi SDK] ========================================
[Pi SDK] CRITICAL: About to create Pi payment
[Pi SDK] ========================================
[Pi SDK] Input parameters:
[Pi SDK]   - paymentId: ... (string)
[Pi SDK]   - amount: 10 (number)
[Pi SDK]   - memo: ... (string)
[Pi SDK]   - merchantId: merchant_1777154251759_lvrls7qpa (string)
[Pi SDK]   - merchantAddress: 788fda28-af7c-46a5-... (string)
[Pi SDK] ========================================

[Pi SDK] Metadata object being sent to Pi.createPayment():
{
  "paymentId": "...",
  "merchantId": "merchant_1777154251759_lvrls7qpa",
  "merchantAddress": "788fda28-af7c-46a5-..."
}
```

**✅ تحقق:**
- merchantId و merchantAddress موجودين؟ ✓ / ✗
- القيم صحيحة (زي الخطوة 2)؟ ✓ / ✗

---

## عند موافقة Pi Wallet

في backend logs ابحث عن:

```
[Pi Webhook] APPROVE called at 2026-04-25T...

[Pi Webhook] ========================================
[Pi Webhook] FULL PAYLOAD FROM PI SDK:
[Pi Webhook] Raw JSON: {
  "identifier": "...",
  "metadata": {
    "paymentId": "...",
    "merchantId": "merchant_1777154251759_lvrls7qpa",
    "merchantAddress": "788fda28-af7c-46a5-..."
  },
  ...
}

[Pi Webhook] CRITICAL VALIDATION
[Pi Webhook] Is merchantId present? true
[Pi Webhook] Is merchantAddress present? true
[Pi Webhook] ========================================

[Pi Webhook] CRITICAL: CACHING MERCHANT METADATA
[Pi Webhook] Merchant ID to cache: merchant_1777154251759_lvrls7qpa
[Pi Webhook] Merchant Address to cache: 788fda28-af7c-46a5-...
[Pi Webhook] ✅ Metadata cached successfully
```

**✅ تحقق:**
- merchantId و merchantAddress موجودين في metadata؟ ✓ / ✗
- Metadata cached successfully؟ ✓ / ✗
- نفس القيم من الفرونت؟ ✓ / ✗

---

## عند إكمال الدفعة في Pi Wallet

في backend logs ابحث عن:

```
[Pi Webhook] COMPLETE called at 2026-04-25T...

[Pi Webhook] ========================================
[Pi Webhook] PAYMENT RETRIEVED FROM REDIS
[Pi Webhook] Payment ID: ...
[Pi Webhook] Merchant ID: merchant_1777154251759_lvrls7qpa
[Pi Webhook] Merchant Address: 788fda28-af7c-46a5-...
[Pi Webhook] Amount: 10
[Pi Webhook] Status: PENDING
[Pi Webhook] ========================================

[Pi Webhook] ========================================
[Pi Webhook] MERCHANT DATA RESOLUTION
[Pi Webhook] Source 1 - Cached metadata:
[Pi Webhook]   - merchantId: merchant_1777154251759_lvrls7qpa
[Pi Webhook]   - merchantAddress: 788fda28-af7c-46a5-...
[Pi Webhook] ========================================
```

**✅ تحقق:**
- merchantId و merchantAddress موجودين من Redis؟ ✓ / ✗
- Cached metadata يحتوي على نفس القيم؟ ✓ / ✗

---

## ✅ علامات النجاح الكاملة

إذا شفت كل هذه:
1. ✅ Frontend: merchantId و merchantAddress بقيمة صحيحة وليست "unknown" أو فارغة
2. ✅ Operations: نفس القيم من الفرونت
3. ✅ Pi SDK: metadata object فيه المتaddr و merchantId صحيح
4. ✅ /api/pi/approve: استقبل البيانات الصحيحة وcached بشكل صحيح
5. ✅ /api/pi/complete: استرجع البيانات من cache بشكل صحيح
6. ✅ **الدفعة اكتملت بنجاح! ✓**

---

## ❌ علامات المشاكل

إذا شفت أي من هذه، هنا المشكلة:

### مشكلة 1: merchantId = "unknown"
```
[v0][CRITICAL] Server payment merchant data:
  - merchantId: unknown  ❌
```
**السبب:** Payment لم يتم استرجاعه من الخادم، واستُخدم fallback بدون merchant data

### مشكلة 2: merchantAddress = "" (فارغة)
```
[v0][CRITICAL] Server payment merchant data:
  - merchantAddress:   ❌ (فارغة!)
```
**السبب:** Store استخدم default value فارغ عند تمرير "" بدلاً من UUID

### مشكلة 3: merchantId يتغير بين المراحل
```
Frontend:  merchantId = "merchant_A"
Pi Webhook: merchantId = "merchant_B"  ❌
```
**السبب:** إعادة توليد في مكان ما، أو parameter passing خطأ

### مشكلة 4: Pi Webhook لا يستقبل metadata
```
[Pi Webhook] Our Payment ID: ... (✓)
[Pi Webhook] Merchant ID from metadata: (❌ فارغ!)
```
**السبب:** Pi SDK لم يتلقَّ metadata بشكل صحيح من الفرونت

### مشكلة 5: "Please login with Pi wallet first"
هذا يعني merchantAddress فارغة، اتبع خطوات المشكلة 2

---

## كيفية استخدام Console للتصفية

في Chrome DevTools:
1. اذهب للـ Console tab
2. في Filter box (أعلى اليمين)، اكتب: `[v0]` للـ frontend logs فقط
3. أو: `[Pi SDK]` للـ Pi SDK logs
4. أو: `[Operations]` للـ operations logs

---

## معلومات مهمة للتذكر

- **merchantId** = معرّف التاجر الفريد (يبدأ بـ "merchant_")
- **merchantAddress** = Pi wallet address للتاجر (UUID format)
- **paymentId** = معرّف الدفعة الفريد (timestamp + random)
- **NONE من هذه يجب أن تتغير** بين المراحل!

إذا تغيرت أي منهم، هناك أين problem في المسار.
