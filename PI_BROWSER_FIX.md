# Pi Browser QR Code and Authentication Fix

## Issues Fixed

### 1. QR Code Not Opening in Pi Browser
**Problem:** When scanning the QR code with a phone camera, it opened in the default browser (Chrome/Safari) instead of Pi Browser.

**Root Cause:** QR codes contained standard HTTPS URLs (`https://flashpay-two.vercel.app/pay/{id}`). Phone cameras default to opening HTTPS links in the default browser.

**Solution:** Changed QR codes to use Pi Browser deep link protocol:
- Before: `https://flashpay-two.vercel.app/pay/{id}`
- After: `pi://flashpay-two.vercel.app/pay/{id}`

**How it works:**
- The `pi://` protocol is registered by Pi Browser on all devices
- When a phone camera scans a QR code with `pi://`, the OS asks which app to open it with
- Pi Browser is the only app that handles `pi://` protocol, so it opens automatically

### 2. Authentication Failed - No Scope Data
**Problem:** When manually opening the payment page in Pi Browser and clicking Pay, it showed "Authentication failed - no scope data".

**Root Cause:** The payment page wasn't authenticating the customer before they clicked the Pay button. When `Pi.createPayment()` was called, it tried to authenticate inline, but the authentication state wasn't properly initialized.

**Solution:** Added automatic authentication when the payment page loads:
1. Page loads → Initialize Pi SDK
2. SDK ready → Immediately call `authenticateCustomer()` with `["payments"]` scope
3. Authentication succeeds → Enable the Pay button
4. User clicks Pay → Payment flow works because scope is already granted

## Files Modified

### `/lib/router.ts`
Updated `getPiNetPaymentUrl()` to return Pi Browser deep links:
```typescript
export function getPiNetPaymentUrl(id: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://flashpay-two.vercel.app"
  const httpsUrl = `${baseUrl}/pay/${id}`
  const domain = httpsUrl.replace('https://', '')
  return `pi://${domain}` // Returns: pi://flashpay-two.vercel.app/pay/{id}
}
```

### `/app/pay/[id]/payment-content-with-id.tsx`
Added automatic authentication on page load:
```typescript
useEffect(() => {
  async function initPiSDK() {
    // ... SDK initialization ...
    
    if (result.success) {
      setAuthStatus("authenticating")
      const authResult = await authenticateCustomer()
      
      if (authResult.success) {
        setAuthStatus("authenticated")
      } else {
        setAuthStatus("failed")
      }
    }
  }
  
  initPiSDK()
}, [paymentId])
```

## How to Test

### Test 1: QR Code Opens in Pi Browser
1. Merchant creates payment in the app
2. QR code is generated
3. Scan QR code with phone camera (any phone)
4. **Expected:** Phone asks "Open with Pi Browser?" or opens Pi Browser directly
5. **Result:** Payment page opens inside Pi Browser

### Test 2: Payment Works Correctly
1. Payment page loads in Pi Browser
2. Page shows "Authenticating with Pi Browser..."
3. Pi Browser shows authentication popup
4. User grants "payments" permission
5. Page shows payment amount and "Pay with Pi Wallet" button
6. User clicks "Pay with Pi Wallet"
7. **Expected:** Pi Wallet opens, no authentication errors
8. User confirms payment
9. **Result:** Payment completes successfully

## Environment Variables Required

Add this to your Vercel project:
```bash
NEXT_PUBLIC_APP_URL=https://flashpay-two.vercel.app
```

## Pi Browser Deep Link Format

For reference, here's the deep link structure:

### Basic Payment Link
```
pi://flashpay-two.vercel.app/pay/{paymentId}
```

### With Query Parameters (if needed)
```
pi://flashpay-two.vercel.app/pay/{paymentId}?amount=5&note=Coffee
```

### Future Production Domain
Once your app is approved with `flashpay.pi` domain:
```
pi://flashpay.pi/pay/{paymentId}
```

## Additional Notes

### Why Pi Browser Deep Links?
- Pi Browser registers the `pi://` protocol on iOS and Android
- When a QR scanner or any app encounters a `pi://` URL, it routes to Pi Browser
- This is the ONLY reliable way to force a link to open in Pi Browser from external apps

### Authentication Timing
- Authentication MUST happen before `Pi.createPayment()`
- The Pi SDK requires an active session with granted scopes
- Auto-authenticating on page load ensures the session is ready before user interaction

### Vercel KV Storage
- Payments are stored in Vercel KV (Redis)
- This persists across serverless function instances
- Make sure KV is connected in your Vercel project settings

## Troubleshooting

### QR Still Opens in Regular Browser
- Check that the QR code contains `pi://` not `https://`
- Verify Pi Browser is installed on the test device
- Try long-pressing the QR code and selecting "Open with Pi Browser"

### Authentication Still Fails
- Check browser console for Pi SDK errors
- Verify app is approved in Pi Developer Portal
- Ensure "payments" scope is enabled in app settings
- Check that domain matches the one configured in Pi Portal

### Payment Not Found After Scan
- Verify Vercel KV is connected and configured
- Check Vercel logs for KV connection errors
- Ensure `NEXT_PUBLIC_APP_URL` environment variable is set
