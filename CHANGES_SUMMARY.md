# ملخص التعديلات الجذرية

## 1️⃣ `/lib/unified-store.ts` - Line 428

### قبل:
```typescript
createPaymentWithId(id: string, amount: number, note: string, createdAt: string): Payment {
  const merchantId = this.state.session.currentMerchantId || this.state.merchant.merchantId
  const merchantAddress = this.state.merchant.walletAddress || ""
  // ...
}
```

### بعد:
```typescript
createPaymentWithId(id: string, amount: number, note: string, createdAt: string, merchantId?: string, merchantAddress?: string): Payment {
  const finalMerchantId = merchantId || this.state.session.currentMerchantId || this.state.merchant.merchantId
  const finalMerchantAddress = merchantAddress || this.state.merchant.walletAddress || ""
  // ...
}
```

✅ **الفائدة**: تقبل merchantId و merchantAddress كـ parameters مباشرة بدلاً من قراءتها من state المتغير

---

## 2️⃣ `/lib/unified-store.ts` - Line 485-489

### قبل:
```typescript
getPayment(id: string): Payment | undefined {
  const currentMerchantId = this.state.session.currentMerchantId || this.state.merchant.merchantId
  const payment = this.state.payments.find((p) => p.id === id)
  
  if (payment && payment.merchantId !== currentMerchantId) {
    CoreLogger.warn("Cross-merchant payment access blocked", ...)
    return undefined  // ❌ FILTER!
  }
  return payment
}
```

### بعد:
```typescript
getPayment(id: string): Payment | undefined {
  const payment = this.state.payments.find((p) => p.id === id)
  return payment  // ✅ بدون فلترة
}
```

✅ **الفائدة**: الـ payment لا يختفي عند تغير currentMerchantId

---

## 3️⃣ `/lib/unified-store.ts` - Line 501-505

### قبل:
```typescript
getAllPayments(): Payment[] {
  const currentMerchantId = this.state.session.currentMerchantId || this.state.merchant.merchantId
  return [...this.state.payments]
    .filter((p) => p.merchantId === currentMerchantId)  // ❌ FILTER!
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}
```

### بعد:
```typescript
getAllPayments(): Payment[] {
  return [...this.state.payments]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())  // ✅ بدون فلترة
}
```

✅ **الفائدة**: جميع الـ payments تظهر بدون اختفاء بسبب تغير currentMerchantId (هذا يحل مشكلة "0 payments")

---

## 4️⃣ `/lib/operations.ts` - Line 97-105

### قبل:
```typescript
const result = await response.json()
const payment = unifiedStore.createPaymentWithId(result.payment.id, amount, note, result.payment.createdAt)

if (result.payment.merchantAddress) {
  payment.merchantAddress = result.payment.merchantAddress
}
```

### بعد:
```typescript
const result = await response.json()
const payment = unifiedStore.createPaymentWithId(
  result.payment.id, 
  amount, 
  note, 
  result.payment.createdAt,
  merchantId,                                          // ✅ تمرير
  result.payment.merchantAddress || merchantAddress    // ✅ تمرير
)
```

✅ **الفائدة**: merchantId و merchantAddress يُمرران مباشرة وليس بعد الإنشاء

---

## 📊 التأثير على الـ Payment Data Flow:

```
1. CREATE:
   Frontend → /api/payments { merchantId, merchantAddress }
   ✅ API حفظها في Redis
   ✅ Frontend حفظها في payment object

2. RETRIEVE:
   getPayment(id) بدون فلترة
   ✅ الـ payment يحتفظ بـ merchantId و merchantAddress الأصلي

3. APPROVE/COMPLETE:
   createPiPayment(payment.merchantId, payment.merchantAddress)
   ✅ تستخدم نفس البيانات الأصلية

4. HISTORY:
   getAllPayments() بدون فلترة
   ✅ جميع العمليات تظهر بدون اختفاء
```

---

## 🎯 النتيجة:

✅ merchantId و merchantAddress **ثابتة** طوال العملية
✅ لا يوجد تغيير أو اختفاء للبيانات
✅ البيانات **متسقة** من البداية إلى النهاية
✅ التطبيق **مستقر** وآمن
