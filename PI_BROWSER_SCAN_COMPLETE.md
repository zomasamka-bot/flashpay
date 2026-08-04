# Pi Browser "Scan to Pay" - Complete Implementation

## Summary
Fixed and completed the Pi Browser scanning feature with real QR code decoding, proper component rendering, and correct payload encoding.

## What Was Fixed

### 1. **Real QR Code Decoding**
   - Added jsQR (already in package.json) to `PiBrowserScanner`
   - Camera scan now decodes QR frames in real-time
   - Image upload now decodes QR from uploaded images
   - Validates format: exactly `flashpay:{canonical-UUID}`

### 2. **Correct QR Payload Display**
   - Home merchant view now displays **two QR codes**:
     - **Main QR**: Vercel route (`/pay/{id}`) - unchanged, works in all browsers
     - **Pi Browser QR**: Scan payload (`flashpay:{id}`) - new, visible below main QR in blue section
   - Both QR codes coexist without conflict

### 3. **Proper Component Rendering**
   - Scanner handler now renders `PaymentContentWithId` with:
     - `paymentId={scannedId}` - the extracted UUID
     - `entry="pi"` - identifies scan entry mode
   - No navigation, no duplicate payment creation
   - Reuses existing payment lifecycle, backend fetch, and settlement

### 4. **Maintained Vercel Flow**
   - `/pay/[id]` route unchanged
   - Vercel QR generation unchanged
   - Share URL unchanged (includes amount, note)
   - All SDK, auth, APIs, Redis, settlement logic untouched

## File Changes

- **`components/pi-browser-scanner.tsx`**
  - Added jsQR lazy loader and real QR decoding in `scanFrame()`
  - Updated image upload with jsQR decoding
  - Validates `flashpay:UUID` format exactly
  - Logs extracted payment ID

- **`app/page.tsx`**
  - Removed `CustomerPaymentView` import (replaced with dynamic import)
  - Added `handleScanPaymentId` to render `PaymentContentWithId` with `entry="pi"`
  - Added Pi Browser QR display section showing `piBrowserQRPayload`
  - Kept Vercel QR and share URL completely unchanged
  - Added `showPiBrowserScanner` state and modal

- **`lib/router.ts`**
  - Added `getPiScanQRPayload()` function returning `flashpay:{id}`
  - Kept all existing URL functions for Vercel

## Test Scenario: Two Devices

### Device A (Merchant - Pi Browser Home)
1. Opens FlashPay home
2. Creates payment: 10π, note "Coffee"
3. Merchant QR generated showing `/pay/{id}` (Vercel)
4. **New**: Pi Browser QR section appears showing `flashpay:{id}` payload

### Device B (Customer - Pi Browser Scanner)
1. Opens FlashPay home
2. Taps "Scan to Pay (Pi Browser)"
3. Scanner modal opens
4. Scans QR from Device A's Pi Browser section
5. jsQR decodes: `flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890`
6. Validates UUID format ✓
7. Extracts UUID ✓
8. Renders `PaymentContentWithId` with `entry="pi"` ✓
9. Fetches payment from backend ✓
10. Completes payment via existing lifecycle ✓

### Fallback Paths
- Image upload: Select QR screenshot, jsQR decodes
- Manual entry: Type `flashpay:UUID`, validates, extracts

## Decoder Library
- **jsQR 1.4.0**: Already in package.json
- Lazy-loaded in `PiBrowserScanner` for performance
- Single maintained decoder instance via module-level variable

## No Breakage
- Vercel QR (`/pay/{id}`) renders and works normally
- Share URL unchanged
- All existing payment flows untouched
- SDK, auth, APIs unchanged
- Settlement and Redis workflows unchanged
