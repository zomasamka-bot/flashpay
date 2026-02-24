# Customer Authentication Troubleshooting Guide

## Issue: "Wallet not connected" error when customer clicks "Pay with Pi Wallet"

### Symptoms
- Merchant wallet connects successfully
- QR code generates correctly
- Customer scans QR and opens payment page
- When customer presses "Pay with Pi Wallet" button, error appears:
  - "Payment Failed – Wallet not connected. Please ensure you've authenticated with Pi Wallet and granted 'payments' scope."
- Vercel logs show payment created successfully on server
- Error occurs on customer's device during payment execution

---

## Root Cause Analysis

### Authentication Flow
1. **Customer opens payment page** (`/pay/[id]`)
2. **Pi SDK initializes** (`initializePiSDK()`)
3. **Customer authentication triggered** (`authenticateCustomer()`)
   - Requests `["payments"]` scope (NOT `["username", "payments"]`)
   - Pi Wallet should prompt customer to approve
   - On approval, sets `isConnected: true` in unified store
4. **Payment button becomes enabled**
5. **Customer clicks "Pay with Pi Wallet"**
6. **Pre-flight check** verifies `walletStatus.isConnected`
7. **Payment executes** via `createPiPayment()`

### Failure Point
The error "Wallet not connected" means one of:
1. Customer authentication never completed successfully
2. Wallet status wasn't persisted in store
3. Customer denied the authentication prompt
4. Pi Wallet didn't grant 'payments' scope
5. Authentication timed out or failed silently

---

## Fixes Applied in Latest Version

### 1. Pre-Flight Authentication Check
**File:** `/components/customer-payment-view.tsx`

Added comprehensive checks before payment execution:
```typescript
const handlePay = async () => {
  // Check local auth state
  if (!isAuthenticated) {
    toast({ title: "Authentication Required", ... })
    return
  }
  
  // Check store wallet status
  const walletStatus = unifiedStore.getWalletStatus()
  if (!walletStatus.isConnected) {
    // Try to re-authenticate
    const reauth = await authenticateCustomer()
    if (!reauth.success) {
      // Show error and block payment
      return
    }
  }
  
  // Proceed with payment
  executePayment(...)
}
```

### 2. Explicit Wallet Status Updates
**File:** `/lib/pi-sdk.ts`

Enhanced authentication to verify status persistence:
```typescript
export const authenticateCustomer = async () => {
  const authResult = await window.Pi.authenticate(["payments"], ...)
  
  if (authResult) {
    // Update store
    unifiedStore.updateWalletStatus({
      isConnected: true,
      isInitialized: true,
      isPiSDKAvailable: true,
      lastChecked: new Date(),
    })
    
    // Verify update was persisted
    const verifyStatus = unifiedStore.getWalletStatus()
    if (!verifyStatus.isConnected) {
      console.error("Wallet status update did not persist!")
    }
  }
}
```

### 3. Visual Auth Status Indicator
**File:** `/components/customer-payment-view.tsx`

Added visual confirmation when wallet is connected:
```typescript
{!isPaid && piSDKReady && isAuthenticated && (
  <>
    <div className="p-2 bg-primary/10 border">
      ✓ Wallet Connected
    </div>
    <Button onClick={handlePay}>
      Pay with Pi Wallet
    </Button>
  </>
)}
```

### 4. Better Error Recovery
When payment fails with scope error:
- Resets `isAuthenticated` to `false`
- Shows authentication UI again
- Provides clear instructions

---

## Testing Checklist

### Test in Developer Portal (Step 10)
1. Click "Incomplete Transaction URLs" link
2. Accept "Open in Pi app" prompt
3. **IMPORTANT:** Watch for Pi Wallet authentication popup
4. **Customer MUST approve** the authentication
5. Wait for "✓ Wallet Connected" indicator
6. Click "Pay with Pi Wallet"
7. Check console for pre-flight checks

### Check Console Logs
Look for this sequence:
```
[v0][CustomerView] Mounted with payment ID: xxx
[v0][CustomerView] Initializing Pi SDK...
[v0][CustomerView] Pi SDK ready: true
[v0][CustomerView] Authenticating customer with 'payments' scope...
[v0] ✅ Customer auth result received: {...}
[v0] Updating wallet status: isConnected=true
[v0] Wallet status after update: {isConnected: true, ...}
[v0][CustomerView] ✅ Customer authenticated successfully
[v0][CustomerView] ========== PAYMENT BUTTON CLICKED ==========
[v0][CustomerView] Pre-flight checks:
[v0][CustomerView] - isAuthenticated: true
[v0][CustomerView] - piSDKReady: true
[v0][CustomerView] Wallet status from store: {isConnected: true, ...}
[v0][CustomerView] ✅ All pre-flight checks passed
```

If you see:
```
[v0][CustomerView] ❌ Authentication failed: ...
```
Or:
```
[v0][CustomerView] ❌ Payment blocked: Wallet not connected in store
```
Then authentication didn't complete successfully.

---

## Common Issues & Solutions

### Issue 1: Customer denies authentication
**Symptom:** Error message says "timeout" or "not responding"
**Solution:** 
- Customer must approve the Pi Wallet authentication prompt
- Customer must grant "payments" scope
- Try tapping the payment link again to re-trigger auth

### Issue 2: Domain mismatch
**Symptom:** Authentication never triggers, or fails immediately
**Solution:**
- Verify app is accessed via `flashpay0734.pi` (PiNet subdomain)
- Check Developer Portal domain configuration
- See `PI_DOMAIN_AND_SCOPE_DEBUG.md` for domain troubleshooting

### Issue 3: 'payments' scope not enabled
**Symptom:** Authentication completes but payment still fails
**Solution:**
- Go to Pi Developer Portal
- Navigate to your app settings
- Ensure "payments" scope is enabled and checked
- Save changes
- Re-authenticate

### Issue 4: Wallet status not persisting
**Symptom:** Auth succeeds but `isConnected` is false
**Solution:**
- Check browser localStorage isn't full or blocked
- Clear Pi Browser app data
- Try in incognito/private mode
- Check console for storage errors

---

## Developer Portal Configuration

### Required Settings
1. **App Status:** Must be "Development" or "Approved"
2. **Scopes:** Enable "payments" (username not required for customers)
3. **Domain:** Set to `flashpay0734.pi` (PiNet subdomain)
4. **Platform:** Pi Browser

### Verification Steps
1. Open Developer Portal
2. Select your app
3. Go to "App Settings"
4. Check "Scopes" section
5. Verify "payments" has a checkmark
6. Save if changes were made
7. Clear Pi Browser app data
8. Re-test

---

## Manual Authentication Test

If authentication is failing, test manually:

1. Open payment page in Pi Browser
2. Open browser console (if available in Pi Browser)
3. Run this command:
```javascript
window.Pi.authenticate(['payments'], () => {})
  .then(auth => console.log('Auth success:', auth))
  .catch(err => console.log('Auth error:', err))
```
4. You should see Pi Wallet popup
5. Approve the authentication
6. Check console for success message

---

## Next Steps If Issue Persists

1. **Check Vercel Logs**
   - Look for any server-side errors
   - Verify `/api/pi/approve` and `/api/pi/complete` are working

2. **Test with Different Payment**
   - Create a new payment request
   - Use a different device if possible
   - Try different Pi Network account

3. **Verify Pi SDK Version**
   - Check `lib/pi-sdk.ts`
   - Should be version "2.0"
   - `sandbox: false` for PiNet subdomain

4. **Contact Pi Network Support**
   - If all else fails, issue may be with Pi Browser/SDK
   - Provide app ID and error details
   - Include console logs

---

## Success Indicators

You know authentication is working correctly when:
1. ✅ "✓ Wallet Connected" appears on payment page
2. ✅ Console shows "Customer authenticated successfully"
3. ✅ Payment button is enabled (not grayed out)
4. ✅ Clicking "Pay with Pi Wallet" opens Pi Wallet immediately
5. ✅ No "Wallet not connected" errors appear

---

## Related Documentation
- `PI_DOMAIN_AND_SCOPE_DEBUG.md` - Domain troubleshooting
- `ERROR_QUICK_REFERENCE.md` - Quick error solutions
- `FIXES_APPLIED.md` - Complete list of fixes
- `DEPLOYMENT.md` - Deployment and domain setup
