# FINAL FIX: Payments Scope Authentication

## Problem
Customer received error: **"Cannot create a payment without 'payments' scope"**

This occurred because `Pi.createPayment()` was being called without first obtaining the 'payments' scope through `Pi.authenticate()`.

## Root Cause
The Pi SDK has a **strict two-step flow** that must be followed:

1. **Step 1:** `Pi.authenticate({ scopes: ['payments'] })` - User grants the 'payments' scope
2. **Step 2:** `Pi.createPayment()` - Payment can now be created

In previous fix attempts, I incorrectly removed the authentication step, assuming the SDK would handle it automatically. This is **wrong**. The 'payments' scope MUST be explicitly requested and granted before any payment can be created.

## Solution Applied

### File: `/components/customer-payment-view.tsx`

**Restored the authentication flow in the `useEffect` init function:**

```typescript
async function init() {
  // Step 1: Initialize Pi SDK
  const sdkResult = await initializePiSDK()
  setPiSDKReady(sdkResult.success)
  
  if (!sdkResult.success) {
    // Handle SDK init failure
    return
  }

  // Step 2: Authenticate with 'payments' scope (REQUIRED)
  const authResult = await authenticateCustomer()
  
  if (authResult.success) {
    setIsAuthenticated(true)  // Now payments can be created
  } else {
    setIsAuthenticated(false) // Block payment button
    setAuthError(authResult.error)
  }
}
```

**Updated payment button to only show when authenticated:**

```typescript
{!isPaid && piSDKReady && isAuthenticated && (
  <Button onClick={handlePay}>
    Pay with Pi Wallet
  </Button>
)}
```

## What This Fix Does

### On Page Load:
1. ✅ Initialize Pi SDK
2. ✅ Call `Pi.authenticate({ scopes: ['payments'] })` automatically
3. ✅ User is prompted to grant 'payments' scope
4. ✅ Once granted, `isAuthenticated` is set to `true`
5. ✅ Payment button becomes available

### When User Clicks "Pay with Pi Wallet":
1. ✅ `Pi.createPayment()` is called
2. ✅ Payment succeeds because 'payments' scope was already granted
3. ✅ No scope error occurs

## Key Changes

### What Was Wrong (Previous Fix)
```typescript
// WRONG: Skipped authentication
setIsAuthenticated(true) // SDK ready means ready for payment
```

This assumed the SDK would handle authentication internally, but it doesn't. The 'payments' scope must be explicitly requested.

### What Is Correct (Current Fix)
```typescript
// CORRECT: Explicitly authenticate with payments scope
const authResult = await authenticateCustomer()
if (authResult.success) {
  setIsAuthenticated(true)
}
```

## Testing Steps

1. **Deploy the app** with this fix
2. **Generate QR code** as merchant (Step 10 in Developer Portal)
3. **Customer scans QR** and opens payment page
4. **Customer is prompted** to grant 'payments' scope (automatic)
5. **After granting scope**, "Pay with Pi Wallet" button appears
6. **Customer clicks button** → Payment should succeed ✅

## Developer Portal Requirements

Ensure these settings are correct:

- ✅ **App Domain:** `flashpay0734.pi` (PiNet subdomain)
- ✅ **Scopes:** `payments` scope is enabled
- ✅ **Status:** App is approved/development mode
- ✅ **Sandbox:** Set to `false` for PiNet subdomain

## Expected Flow

```
Customer opens payment page
     ↓
Pi SDK initializes
     ↓
Pi.authenticate({ scopes: ['payments'] }) called automatically
     ↓
Customer prompted: "Grant FlashPay access to make payments?"
     ↓
Customer clicks "Approve"
     ↓
'payments' scope granted ✅
     ↓
"Pay with Pi Wallet" button appears
     ↓
Customer clicks button
     ↓
Pi.createPayment() succeeds ✅
     ↓
Payment completed
```

## Why This Fix Is Correct

1. **Follows Pi SDK documentation:** Authenticate first, then create payment
2. **Explicit scope request:** No assumptions about automatic authentication
3. **User consent flow:** Customer knowingly grants payments permission
4. **Error handling:** If authentication fails, payment button is hidden
5. **Proper state management:** `isAuthenticated` tracks scope grant status

## Summary

The fix restores the required `Pi.authenticate({ scopes: ['payments'] })` call that was incorrectly removed. This ensures customers explicitly grant the 'payments' scope before any payment creation attempt, eliminating the "Cannot create a payment without 'payments' scope" error.
