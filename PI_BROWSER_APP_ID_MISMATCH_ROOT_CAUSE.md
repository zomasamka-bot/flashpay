# Pi Browser App ID Mismatch - Root Cause Analysis

## المشكلة

عند استخدام التطبيق في Pi Browser:
- **U2A ينجح** (دفع من العميل إلى التطبيق) ✅
- **A2U يفشل** مع خطأ "user_not_found" ❌
- **App ID في Pi Browser** يختلف عن **App ID في Developer Portal**

## الفرق بين الـ App IDs

### 1. **Dev Portal App ID** (محفوظ في PI_API_KEY)
```
authResult.user.app_id = "محدد من قبل Pi Developer Portal"
(هذا هو App ID التطبيق الحقيقي)
```

### 2. **Pi Browser App ID** (قد يكون مختلفاً)
```
عندما يتم فتح flashpay0734.pinet.com في Pi Browser:
- Pi Browser قد يعطي default app context
- أو يستخدم old cached session من PI_API_KEY القديم
- النتيجة: App ID في authResult.user.app_id ≠ App ID الجديد في PI_API_KEY
```

## لماذا A2U يفشل

### التسلسل:
1. **Payment Creation** (`/api/payments`)
   - Frontend يرسل `accessToken` من Pi.authenticate()
   - Backend يتحقق من `/v2/me` باستخدام هذا `accessToken`
   - UID يتم تخزينه مع App Context

2. **A2U Settlement** (`/api/pi/a2u`)
   - Backend يحاول `createPayment` باستخدام PI_API_KEY الجديد
   - لكن `merchantUid` مسجل تحت **App Context القديم** (من قبل تغيير PI_API_KEY)
   - Pi Network ترفض: "user_not_found" لأن:
     - App Context A مع PI_API_KEY_OLD = UID صحيح ✅
     - App Context B مع PI_API_KEY_NEW = UID غير معروف ❌

## الأسباب الممكنة

### 1. **Session Cache في Pi Browser**
عند تغيير PI_API_KEY:
- Pi Browser قد يبقيها cached قديماً
- عند تسجيل الدخول من جديد، يستخدم old session context
- `authResult.user.app_id` لا يزال يشير للـ app context القديم

### 2. **NEXT_PUBLIC_APP_URL Mismatch**
إذا كان `NEXT_PUBLIC_APP_URL` يشير لـ domain قديمة:
- Pi SDK قد يربط session بـ app ID قديم
- عند A2U، PI_API_KEY الجديد لا يتطابق مع saved UID

### 3. **Incomplete Redeployment**
إذا تم تحديث PI_API_KEY لكن لم يتم redeploy كامل:
- البعض من instances لا تزال تستخدم PI_API_KEY القديم
- U2A ينجح (لأن Pi SDK يعرّفك)
- A2U يفشل (لأن server API key مختلفة)

## الحل

### الخطوة الأولى: تحديد الفرق
1. **في Pi Browser**: افتح Developer Console وقم بـ authenticate
2. اطلب logs من `[MERCHANT-AUTH]` block
3. ابحث عن: `authResult.user.app_id`
4. قارن مع: `app_id` في Pi Developer Portal

### الخطوة الثانية: تنظيف الـ Cache
**في Pi Browser:**
```
Settings → Clear cache
أو
Developer Tools → Clear storage → Clear All
```

### الخطوة الثالثة: إعادة تسجيل الدخول
1. Clear all browser data
2. فتح التطبيق من جديد
3. إعادة authenticate
4. محاولة الدفع من جديد

### الخطوة الرابعة: التحقق من الإعدادات
تأكد من:
```
Vercel Environment Variables:
- PI_API_KEY = الجديد (من Developer Portal الحالي)
- NEXT_PUBLIC_APP_URL = صحيح (Vercel domain فقط)
```

## Logging Strategy

الـ logs تظهر بوضوح:
- `[MERCHANT-AUTH]` يطبع `app_id` عند authenticate
- `[Pi A2U]` يطبع `/v2/me` response عند A2U
- تابع app_id عبر هذين المرحلتين

إذا كانت مختلفة = هذه هي المشكلة
