# Wallet Address Synchronization Fix

## المشكلة
عند محاولة إنشاء دفع، يظهر خطأ "Merchant wallet not connected" رغم أن المحفظة متصلة في الواجهة.

السبب: عدم تزامن بين حالة الاتصال المعروضة و `walletAddress` المحفوظ في `unifiedStore.state.merchant.walletAddress`.

## الحلول المطبقة

### 1. في `/lib/pi-sdk.ts` - استرجاع walletAddress من مصادر متعددة
- محاولة جلب من `authResult.user.walletAddress`
- Fallback: `window.Pi.wallet.userInfo()` 
- Fallback: `window.Pi.user.address`

### 2. في `/lib/operations.ts` - Fallback recovery
- محاولة جلب من localStorage مباشرة (في حالة تأخير التزامن)
- Fallback: `window.Pi.wallet.address`

### 3. في `/lib/unified-store.ts` - Logging للتحقق
- إضافة console.log في `completeMerchantSetup()` لتتبع حفظ walletAddress
- إضافة تحقق من الحالة بعد الحفظ

## Debug Logs المتاحة
```
[v0] completeMerchantSetup called with: { piUsername, walletAddress, merchantId }
[v0] After completeMerchantSetup, merchant state is: { ... }
[v0] createPayment: Initial merchant data retrieval: { ... }
[v0] createPayment: walletAddress is empty, attempting fallback recovery...
[v0] createPayment: Recovered walletAddress from localStorage...
[v0] Creating payment with merchant data: { merchantId, merchantAddress, amount, noteLength }
```

## الضمانات
- لا توجد breaking changes
- توافق عكسي كامل
- يمكن تتبع المشكلة بوضوح من الـ logs
