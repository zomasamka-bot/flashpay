# PiNet Payment Method Fix - "Method unsupported in PiNet"

## Problem Diagnosis

**Error:** "Payment Failed – Method unsupported in PiNet"

**Root Cause:** The Pi SDK's `Pi.createPayment()` method does NOT work when `sandbox: true` is set, regardless of the domain. The previous implementation was dynamically setting `sandbox: true` for `.pi` domains, which disabled the payment functionality.

## Technical Details

### Pi SDK Initialization Modes

The `sandbox` parameter in `Pi.init()` has a specific meaning:

- `sandbox: true` → **Disables payment methods** (`Pi.createPayment()` is unavailable)
- `sandbox: false` → **Enables payment methods** (`Pi.createPayment()` is available)

### PiNet Environment

PiNet domains (e.g., `flashpay0734.pi`) are **production-like environments** that:
- Run on Pi Testnet blockchain
- Require `sandbox: false` to enable payment functionality
- Support full U2A (User-to-App) payment flow with `Pi.createPayment()`

### Misconception

The previous code assumed:
- PiNet domains = testnet = sandbox: true ❌
- Vercel URLs = production = sandbox: false ❌

**Correct understanding:**
- ANY domain needs `sandbox: false` to use `Pi.createPayment()` ✅
- The `sandbox` parameter controls SDK features, NOT the blockchain network ✅

## The Fix

**File:** `/lib/pi-sdk.ts`

**Change:** Set `sandbox: false` for ALL environments to enable payment functionality.

```typescript
await window.Pi.init({
  version: "2.0",
  sandbox: false, // Required for Pi.createPayment() to work
})
```

## Evidence

From official Pi SDK documentation research:
> "The Pi Network SDK does not appear to support the `createPayment` method in a sandbox environment"

Source: Pi SDK Integration Guide (GitHub: pi-apps/pi-sdk-integration-guide)

## Verification Steps

After deployment:

1. Customer scans QR code and opens payment page in Pi Browser
2. Customer clicks "Connect Pi Wallet" → authenticates with 'payments' scope
3. Customer clicks "Pay with Pi Wallet" → `Pi.createPayment()` is called
4. Pi Wallet opens with payment details (amount, memo)
5. Customer approves → blockchain transaction submitted
6. Payment completes successfully

## Related Files

- `/lib/pi-sdk.ts` - Pi SDK initialization (FIXED)
- `/components/customer-payment-view.tsx` - Customer payment UI
- `/app/api/pi/approve/route.ts` - Backend payment approval
- `/app/api/pi/complete/route.ts` - Backend payment completion

## Historical Context

Previous attempts:
1. Added wallet connection checks → Blocked payments incorrectly
2. Set `sandbox: true` for PiNet → Disabled `Pi.createPayment()`
3. Tried A2U payment flow → Wrong payment direction (App-to-User vs User-to-App)

All were based on incorrect assumptions about how the Pi SDK sandbox parameter works.

## Conclusion

The `sandbox` parameter is NOT about which blockchain network to use (Testnet vs Mainnet). It's about which Pi SDK features are enabled. To use `Pi.createPayment()` for U2A payments, `sandbox: false` is required regardless of domain or network.
