# PiNet Sandbox Mode Fix

## Problem Identified

**Error:** "Method unsupported in PiNet"

**Root Cause:** The Pi SDK was initialized with `sandbox: false` on all domains, but PiNet domains (`.pi` hostnames) require `sandbox: true` for payment methods to work correctly.

## The Issue

PiNet is Pi Network's internal environment for testing apps before they go live on Mainnet. When running on a PiNet domain like `flashpay0734.pi`, the Pi SDK must be initialized with `sandbox: true` to enable payment functionality.

### Previous Code (INCORRECT)
```typescript
await window.Pi.init({
  version: "2.0",
  sandbox: false, // This breaks payments on PiNet domains
})
```

### Fixed Code (CORRECT)
```typescript
// Detect if running on PiNet domain
const hostname = window.location.hostname
const isPiNetDomain = hostname.endsWith(".pi")

// PiNet domains (.pi) MUST use sandbox: true
const sandboxMode = isPiNetDomain

await window.Pi.init({
  version: "2.0",
  sandbox: sandboxMode,
})
```

## How It Works

| Domain Type | Example | sandbox value | Payment Support |
|-------------|---------|---------------|-----------------|
| PiNet (.pi) | flashpay0734.pi | `true` | ✅ Enabled |
| PiNet (.pi) | flashpay.pi | `true` | ✅ Enabled |
| Vercel/External | *.vercel.app | `false` | ⚠️ Limited |
| Localhost | localhost:3000 | `false` | ⚠️ Limited |

## Why This Fixes the Error

1. **Before:** All domains used `sandbox: false`
2. **Problem:** On PiNet, `Pi.createPayment()` is not available with `sandbox: false`
3. **After:** PiNet domains automatically use `sandbox: true`
4. **Result:** `Pi.createPayment()` is now available and functional

## Expected Behavior After Fix

### Customer Flow
1. Customer scans QR code
2. Opens payment page on `flashpay0734.pi`
3. Pi SDK initializes with `sandbox: true`
4. Click "Connect Pi Wallet" → Authentication popup appears
5. Grant "payments" scope → Success
6. Click "Pay with Pi Wallet" → Payment popup appears
7. Confirm payment → Transaction completes
8. Payment status updates to "PAID"

### Console Output
```
[v0] Detecting environment for Pi SDK init:
[v0] - hostname: flashpay0734.pi
[v0] - isPiNetDomain: true
[v0] Initializing Pi SDK with sandbox: true
[v0] Pi SDK initialized successfully
```

## Testing Instructions

1. Deploy the updated app to Vercel
2. Access via Developer Portal Step 10
3. Merchant creates payment → QR code generated
4. Customer scans QR code on their phone
5. Page opens in Pi Browser on `flashpay0734.pi`
6. Check console logs to verify `sandbox: true`
7. Click "Connect Pi Wallet" and grant permissions
8. Click "Pay with Pi Wallet"
9. Payment should now complete successfully

## Related Files Modified

- `/lib/pi-sdk.ts` - Added domain detection and dynamic sandbox mode

## Additional Notes

- This fix is automatic and requires no configuration changes
- Works for both current PiNet subdomain (`flashpay0734.pi`) and future production domain (`flashpay.pi`)
- Vercel preview URLs will continue to use `sandbox: false` as intended
- The sandbox mode is logged to console for debugging purposes
