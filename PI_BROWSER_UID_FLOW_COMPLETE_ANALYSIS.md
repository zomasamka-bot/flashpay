# تحليل شامل: UID Flow في Pi Browser - الإجابة على أسئلتك الأربعة

## السؤال الأساسي:
هل A2U يعتمد على `merchantUid` القادم من الواجهة أم أنه يعتمد على UID حديث من `/v2/me`؟

---

## الإجابة: **كلاهما** - وهنا تكمن المشكلة

### المسار الحالي (Flow الكامل):

#### 1️⃣ عند فتح التاجر للتطبيق في Pi Browser:

```
Frontend (Pi Browser):
  ├─ authenticateMerchant() دعوة Pi SDK
  ├─ Pi.authenticate() — ينفذ داخل Pi Browser
  ├─ RESPONSE: authResult.user.uid + authResult.accessToken
  ├─ يتم تخزين في unifiedStore:
  │  ├─ merchant.uid = authResult.user.uid (UID من Pi.authenticate)
  │  └─ merchant.accessToken = authResult.accessToken (token من Pi.authenticate)
  └─ هذا UID يُستخرج من Pi Browser session
```

**المشكلة الأولى**: Pi Browser قد تكون تستخدم App Context قديم من PI_API_KEY السابق

---

#### 2️⃣ عند إنشاء Payment (createPayment):

```
Frontend:
  └─ يأخذ merchantUid من unifiedStore (UID من Pi.authenticate في الخطوة 1)
  
  ↓
  
Backend (/api/payments):
  ├─ يستقبل merchantUid من الواجهة
  ├─ يستقبل accessToken
  ├─ يستدعي /v2/me(accessToken) للتحقق
  │  └─ RESPONSE: { uid, username, wallet_address, ... }
  ├─ verifiedUid = response.uid (UID جديد من Pi API)
  ├─ ربما verifiedUid ≠ merchantUid (الفرق!)
  └─ يخزن في Redis:
     └─ payment.merchantUid = verifiedUid (UID المتحقق)
```

**ملاحظة**: Backend يتحقق من UID لكن قد يأخذ UID آخر من `/v2/me`

---

#### 3️⃣ عند تنفيذ الدفع (U2A - ينجح):

```
Pi Wallet → Pi Network (داخل Pi Browser)
  └─ المبلغ ينتقل من عميل إلى محفظة التطبيق ✅

هنا NO verification needed — Pi Browser يثق بـ U2A
```

**لماذا ينجح U2A**: لأنه تحويل من عميل إلى محفظة التطبيق (نفس App)

---

#### 4️⃣ عند تحويل الأموال للتاجر (A2U - **FAILS**)

```
Backend (/api/pi/a2u/route.ts):

  ├─ 1. يستقبل merchantUid من الواجهة (الـ merchantUid الأصلي)
  ├─ 2. يستقبل accessToken
  ├─ 3. يستدعي /v2/me(accessToken) 
  │     └─ RESPONSE: { uid: "verified-uid", ... }
  ├─ 4. يتحقق: does verified-uid === merchantUid?
  │     └─ قد تكون NO ❌
  ├─ 5. إذا كانت مختلفة: ERROR - "UID mismatch"
  └─ 6. إذا كانت متطابقة:
       ├─ يستدعي Pi.createPayment(API_KEY)
       │  └─ PARAM: uid = merchantUid (من الواجهة أو Redis)
       └─ Pi API يبحث عن هذا UID في database الخاص به
          └─ **ERROR: user_not_found** ❌
             = هذا UID موجود في Pi Network العام
             = لكن ليس في database app الخاص ب PI_API_KEY
```

---

## 🔴 **ROOT CAUSE: App ID Mismatch**

### السيناريو الذي يحدث الآن:

```
1. OLD PI_API_KEY (AppID_Old) → كان مرتبطاً بـ Test App
2. غيرت PI_API_KEY → PI_API_KEY_New (AppID_New) → app credentials جديدة

3. Pi Browser في الجهاز:
   ├─ قد تكون cached تستخدم AppID_Old من السابق
   ├─ عند Pi.authenticate() في Pi Browser:
   │  └─ ترجع uid مرتبط بـ AppID_Old
   
4. Backend:
   ├─ يستخدم PI_API_KEY_New (AppID_New)
   ├─ يحاول sendPayment مع uid من AppID_Old
   └─ **user_not_found** ❌
```

---

## ✅ الحل:

### Step 1: Clear Pi Browser Cache
```
في Pi Browser:
  ├─ Settings → Clear Data
  ├─ Refresh Page
  └─ Re-authenticate
```

### Step 2: Verify App Context
```
عند Authentication في Pi Browser:
  ├─ اطبع: authResult.user.app_id
  └─ تحقق أنها تطابق App في Pi Developer Portal
```

### Step 3: Verify PI_API_KEY
```
على Vercel:
  ├─ التحقق أن PI_API_KEY = Key من Developer Portal
  └─ أن AppID في Dashboard يطابق
```

### Step 4: Test A2U With New Session
```
في Pi Browser (بعد Clear Cache):
  ├─ Authenticate مرة أخرى
  ├─ Create Payment
  ├─ Approve (U2A ينجح) ✅
  └─ Check A2U logs (يجب أن ينجح الآن) ✅
```

---

## 📋 Logs التي يجب تفحصها:

### في Pi Browser Console:
```javascript
// بحث عن:
"[MERCHANT-AUTH] authResult.user.app_id: ???"
"[MERCHANT-AUTH] User UID from Pi: ???"
```

### في Backend Logs (Vercel):
```
[Pi A2U] Merchant UID to verify: ??? (من الواجهة)
[Pi A2U] /v2/me response UID: ??? (من Pi API)
[Pi A2U] UIDs match: true/false?
[Pi A2U] PI_API_KEY first 8 chars: ??? (تحقق من الـ key)
```

إذا كان الـ UID مختلف أو app_id غير متطابق = هذا هو السبب
