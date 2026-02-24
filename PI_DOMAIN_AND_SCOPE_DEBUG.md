# Pi Domain & Scope Debugging Guide

## Overview
This guide addresses two specific error cases in the FlashPay Pi payment application:

### Case 1: Domain Mismatch (Developer Portal)
**Error**: "Connection Failed – Pi wallet not responding … App Domain is set to flashpay0734.pi"

### Case 2: Missing Payments Scope (Pi Browser)
**Error**: "Payment Failed – Cannot create a payment without 'payments' scope"

---

## Case 1: Domain Mismatch Error

### Problem
When opening the app from the **Developer Portal**, the Pi Wallet connection fails because:
- The app is accessed via an external URL (e.g., `flashpay-two.vercel.app`)
- The registered domain in Pi Developer Portal is `flashpay0734.pi` (PiNet subdomain)
- Pi SDK blocks connections when domains don't match for security reasons

### Solution

#### Step 1: Access via Correct Domain
The app MUST be accessed through one of these approved domains:
- **PiNet Subdomain**: `https://flashpay0734.pi` (currently registered)
- **Main Domain**: `https://flashpay.pi` (when you own it)

#### Step 2: Developer Portal Configuration
1. Open [Pi Developer Portal](https://develop.pi)
2. Navigate to your FlashPay app settings
3. Verify **App Domain** is set to: `flashpay0734.pi`
4. Ensure app status is **"Approved"** or **"Development"**

#### Step 3: Test in Pi Browser
**DO NOT** open the app via:
- ❌ `https://flashpay-two.vercel.app` (external Vercel URL)
- ❌ Any other domain not registered in Developer Portal

**DO** open the app via:
- ✅ `https://flashpay0734.pi` (PiNet subdomain)
- ✅ Pi Browser app list (if configured)

### Technical Details
The app uses `sandbox: false` in Pi SDK initialization:
```typescript
await window.Pi.init({
  version: "2.0",
  sandbox: false, // Required for PiNet subdomains
})
```

This configuration is **correct** for PiNet subdomains like `flashpay0734.pi`.

---

## Case 2: Missing Payments Scope Error

### Problem
When opening the app from **Pi Browser**, wallet connects successfully but payment creation fails with:
> "Cannot create a payment without 'payments' scope"

This means:
- ✅ Pi SDK loaded successfully
- ✅ Domain is correct (connection succeeded)
- ❌ The `payments` scope was not granted during authentication

### Solution

#### Step 1: Verify Developer Portal Scopes
1. Open [Pi Developer Portal](https://develop.pi)
2. Go to your FlashPay app → **Scopes** section
3. **ENSURE** the following scopes are **enabled**:
   - ✅ **payments** (REQUIRED - must be checked)
   - ✅ **username** (optional - for merchant identification)

#### Step 2: Check App Approval Status
The `payments` scope is only available for **approved** apps:
- Navigate to app **Status** in Developer Portal
- If status is "Pending" or "Rejected", the payments scope won't work
- For testing, ensure app is at least in **"Development"** mode

#### Step 3: Re-authenticate After Scope Changes
If you just enabled the `payments` scope:
1. **Clear app data** in Pi Browser (Settings → Apps → FlashPay → Clear Data)
2. **Close and reopen** Pi Browser completely
3. **Open the app again** and authenticate
4. Pi Wallet should now prompt you to grant **payments** scope

#### Step 4: Verify Authentication Flow
The app authentication flow:
```typescript
// Customer authentication (for paying)
window.Pi.authenticate(["payments"], onIncompletePaymentFound)

// Merchant authentication (for creating payment requests)
window.Pi.authenticate(["username", "payments"], onIncompletePaymentFound)
```

When you authenticate, Pi Wallet should show:
- "FlashPay wants to:"
- ✅ **Access payments** (or similar)
- You must **approve** this permission

---

## Testing Checklist

### Before Testing
- [ ] App domain in Developer Portal: `flashpay0734.pi`
- [ ] Scopes enabled: `payments` ✅
- [ ] App status: "Approved" or "Development"
- [ ] Using **Pi Browser** (not Chrome/Safari/etc.)

### Test Case 1: Domain Access
1. [ ] Open `https://flashpay0734.pi` in Pi Browser
2. [ ] Check browser console for domain logs
3. [ ] Expected: SDK initializes without errors
4. [ ] Expected: Authentication prompt appears

### Test Case 2: Payments Scope
1. [ ] Authenticate when prompted
2. [ ] Verify Pi Wallet shows "payments" scope request
3. [ ] Approve the scope
4. [ ] Create a payment request
5. [ ] Click "Pay with Pi Wallet"
6. [ ] Expected: Payment flow starts (no scope error)

---

## Debugging Commands

### Check Current Domain
Open browser console (F12) and run:
```javascript
console.log("Current domain:", window.location.hostname)
console.log("Expected domain:", "flashpay0734.pi")
console.log("Match:", window.location.hostname === "flashpay0734.pi")
```

### Check Pi SDK Status
```javascript
console.log("Pi SDK available:", !!window.Pi)
console.log("Pi.init available:", typeof window.Pi?.init)
console.log("Pi.authenticate available:", typeof window.Pi?.authenticate)
console.log("Pi.createPayment available:", typeof window.Pi?.createPayment)
```

### Check Authentication Status
The app logs authentication status:
```
[v0][CustomerView] Authenticating customer with 'payments' scope...
[v0][CustomerView] ✅ Customer authenticated successfully with 'payments' scope
```

If you see:
```
[v0][CustomerView] ❌ Authentication failed: [error message]
```

This indicates the scope was not granted.

---

## Common Errors & Solutions

### Error: "Pi wallet not responding"
**Cause**: Domain mismatch or app not approved
**Solution**: 
- Use `https://flashpay0734.pi` (not Vercel URL)
- Verify app is approved in Developer Portal
- Ensure you're using Pi Browser

### Error: "Cannot create a payment without 'payments' scope"
**Cause**: Payments scope not enabled or not granted
**Solution**:
- Enable `payments` scope in Developer Portal
- Clear Pi Browser app data
- Re-authenticate and approve the scope

### Error: "Authentication timeout"
**Cause**: Pi Wallet not responding to authentication request
**Solution**:
- Check if Pi Browser is up to date
- Verify app domain exactly matches Developer Portal setting
- Try closing and reopening Pi Browser

### Error: "SDK initialization failed"
**Cause**: Pi SDK script not loading or incompatible environment
**Solution**:
- Ensure you're in Pi Browser (not regular browser)
- Check internet connection
- Check browser console for script loading errors

---

## Environment Variables

Ensure these environment variables are set correctly:

```bash
# .env.local
NEXT_PUBLIC_PINET_SUBDOMAIN=flashpay0734.pi
NEXT_PUBLIC_APP_URL=https://flashpay-two.vercel.app
PI_API_KEY=your_pi_api_key_from_developer_portal
```

The `NEXT_PUBLIC_PINET_SUBDOMAIN` should match your Pi Developer Portal app domain exactly.

---

## Developer Portal Quick Links

- **Pi Developer Portal**: https://develop.pi
- **PiNet Settings**: https://develop.pi (Navigate to your app → PiNet)
- **Pi Network Docs**: https://developers.minepi.com
- **Block Explorer**: https://blockexplorer.minepi.com

---

## Support

If issues persist after following this guide:
1. Check the app's `/diagnostics` page for detailed SDK status
2. Review browser console logs for specific error messages
3. Verify your Pi Developer Portal app configuration
4. Ensure you're testing in Pi Browser (Testnet mode if applicable)

**Key Point**: For Case 1, always use `flashpay0734.pi`. For Case 2, ensure `payments` scope is enabled in Developer Portal and granted during authentication.
