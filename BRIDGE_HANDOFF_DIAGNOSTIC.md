# Bridge Page → Pi Browser Handoff Diagnostic

## Problem
When customer tapped "Open in Pi Browser & Pay" button on the bridge page, Pi Browser opened the FlashPay Home screen instead of the payment page. The Payment ID was not being restored.

## Root Cause
**Bridge button was constructing URL with query param routing, but home page checks hash routing first.**

- **Button launched:** `https://flashpayaefebeff3375.pinet.com/?id={paymentId}&entry=pi`
- **Home page expected:** `https://flashpayaefebeff3375.pinet.com/#/pay/{paymentId}`

The home page routing sequence (line 55-92):
1. **First** checks hash: `/^#\/pay\/([0-9a-f-]{36})$/` ← Hash routing (persists through PiNet facade)
2. **Second** checks pathname: `/^\/pay\/([0-9a-f-]{36})/` ← Direct pathname (lost in PiNet facade)
3. **Last** checks query: `?id=` ← Query param (fallback)

Since PiNet App Studio strips the pathname and only serves `/`, the home page **must** use hash routing to survive the transition.

## Solution

### File: `/app/pay/[id]/payment-content-with-id.tsx`

**Before (line 377):**
```typescript
const piDeepLink = `https://flashpayaefebeff3375.pinet.com/?id=${paymentId}&entry=pi`
```

**After (line 377):**
```typescript
const piDeepLink = `https://flashpayaefebeff3375.pinet.com/#/pay/${paymentId}`
```

### Code Changes

1. **Bridge button URL construction** (payment-content-with-id.tsx lines 376-380):
   - Changed from: query param `?id=` to hash routing `#/pay/{id}`
   - Added debug logging to capture actual URL being launched
   - Simplified URL (removed unused `entry=pi` param since hash routing is self-identifying)

2. **Home page initialization debug logging** (app/page.tsx lines 55-92):
   - Added full URL breakdown logging: origin, pathname, search, hash, href
   - Added regex match logging for hash detection
   - Added state change logging when customer view is detected
   - Added render-time logging to confirm customer view is rendered

## Expected Behavior After Fix

1. **Button launches:**
   ```
   https://flashpayaefebeff3375.pinet.com/#/pay/550e8400-e29b-41d4-a716-446655440000
   ```

2. **Pi Browser receives hash URL** (hash persists through PiNet facade):
   ```
   window.location.hash = "#/pay/550e8400-e29b-41d4-a716-446655440000"
   window.location.pathname = "/"
   window.location.search = ""
   ```

3. **Home page initialization** (line 66):
   ```
   [v0][Home-Init] Checking hash: #/pay/550e8400-e29b-41d4-a716-446655440000
   [v0][Home-Init] Hash regex match result: Match found: 550e8400-e29b-41d4-a716-446655440000
   [v0][Home-Init] ✅ Detected hash payment route: 550e8400-e29b-41d4-a716-446655440000
   ```

4. **Home page render** (line 525):
   ```
   [v0][Home-Render] Route resolved. isCustomerView: true customerPaymentId: 550e8400-e29b-41d4-a716-446655440000
   [v0][Home-Render] ✅ Rendering CustomerPaymentView for: 550e8400-e29b-41d4-a716-446655440000
   ```

5. **Result:** Customer payment page loads with correct Payment ID, showing amount and ready to pay.

## Files Modified
- `/app/pay/[id]/payment-content-with-id.tsx` — Bridge button URL construction (lines 376-413)
- `/app/page.tsx` — Home page routing detection debug logging (lines 55-92, 511-527)

## Unchanged Systems
- Bridge page (QR code, amount display, payment details)
- Vercel flow (all routes work normally)
- Pi SDK internals (auth, payment execution)
- Redis/database (all payment stores unchanged)
- Approve/complete/recovery flows
- Settlement and status handling
- All URLs work through the home page's unified routing logic

## Debug Output to Verify
Once deployed, check browser console logs in Pi Browser for:
- `[v0][BridgeButton-Click]` logs when button is tapped
- `[v0][Home-Init]` logs showing hash detection
- `[v0][Home-Render]` logs showing customer view is rendered
