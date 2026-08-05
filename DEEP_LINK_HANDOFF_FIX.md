# Deep Link Handoff Fix - Payment ID Preservation

## Problem

After scanning the QR and tapping "Open in Pi Browser & Pay" on the bridge page, Pi Browser would open only the FlashPay Home interface instead of the payment page for that same ID. The payment ID was lost during the handoff.

## Root Cause

**Exact Current Launch URL Generated**:
```
https://flashpay.pi/pay/[PAYMENT_ID]?entry=pi&note=[NOTE]
```

**Why ID is Lost**:
PiNet App Studio (the Pi Browser framework) intercepts HTTPS URLs to the registered app domain and **strips the path before handing control to React**. This means:
- Button generates: `https://flashpay.pi/pay/abc123?entry=pi`
- Pi Browser receives and processes it
- PiNet strips to: `https://flashpay.pi/` (loses `/pay/abc123`)
- React router sees: `/` (home route)
- User lands on home page without payment ID

## Root Cause Location

- **File**: `/components/customer-payment-view.tsx`
- **Lines**: 362, 394-395 (button click handler)
- **Issue**: Using `https://` URL scheme which gets stripped by PiNet facade

## Solution

Use the **`pi://` protocol** instead, which is specifically designed to preserve routing through the Pi Browser framework.

**Exact Code Change**:

```typescript
// OLD (BROKEN):
const piAppUrl = `https://flashpay.pi/pay/${paymentId}?entry=pi${shareNote ? `&note=${encodeURIComponent(shareNote)}` : ""}`
window.location.href = piAppUrl

// NEW (FIXED):
const piDeepLink = `pi://flashpay.pi/pay/${paymentId}?entry=pi${shareNote ? `&note=${encodeURIComponent(shareNote)}` : ""}`
window.location.href = piDeepLink
```

**Changed File**: `/components/customer-payment-view.tsx` (lines 362, 394-395)

## Result

- Button now generates: `pi://flashpay.pi/pay/abc123?entry=pi`
- Pi Browser preserves the full path through its facade
- React router correctly receives: `/pay/abc123`
- User lands on payment page with ID intact
- `entry=pi` query param triggers Pi SDK initialization
- Full payment flow executes: authenticate → createPayment → approve → complete → settlement

## Technical Notes

- `pi://` is the registered deep-link protocol for Pi apps
- Already documented in `/lib/router.ts` via `getPiDeepLink()` function
- The `getPiDeepLink()` helper uses exactly this pattern
- This protocol is transparent to React routing - it works like a normal HTTPS URL once inside the app context

## Files Modified

- `/components/customer-payment-view.tsx` - Changed URL scheme in bridge button from `https://` to `pi://`
- `/BRIDGE_PATTERN_DEPLOYMENT.md` - Added critical documentation about protocol choice

## No Changes To

- Bridge page rendering
- QR generation or sharing
- Payment API endpoints
- Redux/Redis state
- Settlement flow
- Status handling
