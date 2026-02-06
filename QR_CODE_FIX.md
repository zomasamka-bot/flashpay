# QR Code URL Fix - Summary

## Problem Identified

When customers scanned payment QR codes with their phone camera:
1. The link opened pointing to a Vercel internal domain (vusercontent.net)
2. This intermediate URL showed only a black screen
3. The payment page never loaded
4. Pi Browser could not be reached

**Root Cause:** Vercel preview deployments use internal vusercontent.net URLs that are not accessible from external browsers or devices.

## Solution Implemented

### 1. Smart URL Detection (`/lib/router.ts`)
Created `getPublicBaseUrl()` function that:
- Detects and rejects Vercel internal URLs (vusercontent.net)
- Detects and rejects localhost URLs
- Falls back to configured NEXT_PUBLIC_APP_URL
- Only uses valid public-facing domains

### 2. Updated QR Code Generation
Modified all QR code generation points to use the new smart URL system:
- `/components/qr-code.tsx` - QR rendering (no changes needed)
- `/app/page.tsx` - Merchant QR generation
- `/app/pay/[id]/payment-content-with-id.tsx` - Customer payment QR
- `/lib/router.ts` - `getSafePaymentUrl()` now uses `getPublicBaseUrl()`

### 3. Enhanced Diagnostics (`/app/diagnostics/page.tsx`)
Added comprehensive URL diagnostics:
- Shows current origin vs configured URL
- Displays which URL QR codes will actually use
- Warns if using vusercontent.net or localhost
- Provides specific error messages and solutions

### 4. Debug Logging
Added console logging to track URL generation:
```javascript
[v0] Current origin: https://...
[v0] NEXT_PUBLIC_APP_URL: https://...
[v0] Generated QR URL: https://...
```

## Required Configuration

### Environment Variable (REQUIRED)
```bash
NEXT_PUBLIC_APP_URL=https://your-public-domain.com
```

Examples:
- Pi Testnet: `https://flashpay0734.pinet.com`
- Vercel Production: `https://flashpay-two.vercel.app`
- Custom Domain: `https://flashpay.yourdomain.com`

### How to Set in Vercel
1. Go to your Vercel project
2. Settings → Environment Variables
3. Add `NEXT_PUBLIC_APP_URL` with your public URL
4. Redeploy the app

## Testing the Fix

### 1. Check Console Logs
When generating a QR code, look for:
```
[v0] Generated QR URL: https://your-public-domain.com/pay/xxx
```

Should **NOT** see vusercontent.net

### 2. Use Diagnostics Page
Navigate to `/diagnostics` to see:
- Current Origin
- Configured App URL  
- QR Codes Will Use (this is what matters!)
- Any warnings or errors

### 3. Scan QR Code
1. Generate a payment request
2. Scan QR code with phone camera
3. Link should open in Safari/browser
4. Select "Open in Pi Browser"
5. Payment page should load correctly

## Expected Flow (After Fix)

```
1. Merchant generates QR code
   → QR contains: https://flashpay0734.pinet.com/pay/abc123

2. Customer scans with phone camera
   → Safari/browser opens: https://flashpay0734.pinet.com/pay/abc123

3. Customer taps "Open in Pi Browser"
   → Pi Browser opens same URL (no domain redirect)

4. Payment page loads in Pi Browser
   → Customer completes payment via Pi Wallet
```

## Files Changed

1. `/lib/router.ts` - Added getPublicBaseUrl() and updated getSafePaymentUrl()
2. `/app/page.tsx` - Updated QR URL generation with vusercontent detection
3. `/app/pay/[id]/payment-content-with-id.tsx` - Uses getSafePaymentUrl()
4. `/app/diagnostics/page.tsx` - Enhanced URL diagnostics
5. `/DEPLOYMENT.md` - New deployment guide
6. `/QR_CODE_FIX.md` - This document

## Verification Checklist

- [ ] NEXT_PUBLIC_APP_URL environment variable is set
- [ ] App redeployed after setting env variable
- [ ] Console shows correct URL (not vusercontent.net)
- [ ] Diagnostics page shows correct "QR Codes Will Use" URL
- [ ] QR code scans and opens in browser
- [ ] "Open in Pi Browser" works correctly
- [ ] Payment page loads in Pi Browser
- [ ] Payment can be completed

## Common Issues & Solutions

### Issue: QR code still shows vusercontent.net
**Solution:** Set NEXT_PUBLIC_APP_URL environment variable and redeploy

### Issue: "Open in Pi Browser" redirects to flashpay.pi
**Solution:** This was the first issue - now fixed. QR codes use /pay/{id} path format

### Issue: Black screen after scanning
**Solution:** Ensure NEXT_PUBLIC_APP_URL points to a publicly accessible domain

### Issue: Works in browser but not from QR scan
**Solution:** The URL in QR must be accessible from external devices. Check diagnostics page.

## Support

If issues persist after implementing this fix:
1. Visit `/diagnostics` page and check all sections
2. Review console logs when generating QR code
3. Verify NEXT_PUBLIC_APP_URL is correct and deployed
4. Check that domain is registered in Pi Developer Portal
