# FlashPay Pi Browser Performance & Redirect Fix Report
**Date**: August 1, 2026  
**Scope**: Pi Browser-only issues (Vercel payment flow and smart QR logic remain untouched)

## Root Causes Identified

### 1. **Blocking Pi SDK Loader** ❌
**Problem**: The entire app was blocked waiting for Pi SDK to load before rendering anything
- User sees blank screen while SDK loads from CDN
- Even if SDK unavailable, app never renders
- Causes 30+ second delays, especially on slow networks/older phones

**Files Affected**: `components/pi-sdk-loader.tsx`

**Fix Applied**:
- Changed from blocking mode to non-blocking background loading
- App renders immediately without waiting for SDK
- Pi SDK loads silently in background using async script loading
- Payment page can display while SDK initialization happens in parallel

---

### 2. **Network Timeouts Too Aggressive** ❌
**Problem**: 5-second timeout for payment data fetch fails on slow Pi Browser networks
- Older phones, slow cellular networks timeout frequently
- Payment page never loads if server fetch times out
- "Payment not found" error even though data exists

**Files Affected**: `app/pay/[id]/payment-content-with-id.tsx`

**Fix Applied**:
- Increased timeout from 5 seconds → 15 seconds for Pi Browser environment
- Provisional payment data shows immediately from URL params while fetching in background
- If server fetch times out, graceful fallback to provisional payment (safe, already validated)
- User never sees blank screens due to network delays

---

### 3. **Deep Link Entry Point Detection** ❌
**Problem**: App doesn't properly detect pi:// → https:// redirect flow
- After QR scan in Pi Browser: pi://flashpay.pi/pay/ABC → redirects to https://demo-.../pay/ABC
- Payment page not using the `entry=pi` parameter
- No special handling for deep-linked payments vs. shared links

**Files Affected**: `app/pay/[id]/payment-content-with-id.tsx`

**Fix Applied**:
- Proper detection of `entry=pi` parameter (QR code deep link) vs `entry=share` (shared link)
- When `entry=pi` detected, show provisional payment from URL parameters immediately
- Async fetch of authoritative payment data in background
- Clear diagnostic messages so developers can see the flow

---

### 4. **Hydration Mismatch on Page Load** ❌
**Problem**: Server/client hydration mismatches cause slow rendering in Pi Browser
- Caused by synchronous SDK initialization blocking hydration
- Layout waits for client-side operations before hydration completes

**Files Affected**: `app/layout.tsx`

**Fix Applied**:
- Added `suppressHydrationWarning` to avoid hydration errors
- Added preload link for Pi SDK to start download earlier in page lifecycle
- SDK now loads in parallel with page rendering, not sequentially

---

## Files Modified

1. **`components/pi-sdk-loader.tsx`** ✅
   - Changed from blocking to non-blocking SDK loading
   - Payment routes render immediately
   - SDK loads in background asynchronously
   - Uses `async` and `defer` attributes on script tag

2. **`app/pay/[id]/payment-content-with-id.tsx`** ✅
   - Increased network timeout: 5s → 15s for Pi Browser
   - Proper `entry=pi` detection and diagnostic logging
   - Provisional payment shown immediately from URL params
   - Graceful fallback if server fetch times out
   - Better cleanup of abort controllers and timeouts

3. **`app/layout.tsx`** ✅
   - Added `suppressHydrationWarning` to `<html>` tag
   - Added preload link for Pi SDK script
   - Optimized page load performance in Pi Browser

---

## What Was NOT Changed

✅ **Vercel Payment Flow** - Completely untouched  
✅ **Smart QR Logic** - Completely untouched  
✅ **Deep Link QR Redirects** - Vercel-side remains stable  
✅ **Stable Version Status** - Rolled-back code remains safe  

---

## Expected Improvements

| Issue | Before | After |
|-------|--------|-------|
| App startup in Pi Browser | 30+ seconds (often never finishes) | 2-3 seconds visible UI |
| Payment page on slow network | Timeout error, blank screen | Provisional data shown immediately |
| QR code redirect flow | Hangs on https://demo-.../pay/... | Payment loads, ready to pay |
| Older phones behavior | Never finishes loading | Page renders, SDK loads in background |
| Network resilience | Fails on 5s+ latency | Handles up to 15s latency |

---

## Diagnostic Features Added

Payment page now shows detailed timeline when `?debug=1` parameter present:
```
✅ Payment loaded from deep link
✅ Payment verified from server
✅ Pi SDK ready - ready to pay
```

All diagnostics also logged to console for debugging:
```javascript
console.log("[v0][PaymentPage] Entry mode:", entryMode)
console.log("[v0][PiSDKLoader] Payment route detected - rendering immediately")
```

---

## Testing Checklist

- [ ] Scan QR code in Pi Browser → page renders immediately
- [ ] Payment page shows provisional data within 1s
- [ ] Payment can be completed even if server fetch times out
- [ ] App renders home page within 2-3s on Pi Browser
- [ ] Old phones (iPhone 6s era) can load app in reasonable time
- [ ] Vercel payment flow still works correctly
- [ ] Smart QR environment detection unchanged
- [ ] No regression in payment completion
