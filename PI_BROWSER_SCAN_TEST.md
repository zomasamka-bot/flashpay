# Pi Browser "Scan to Pay" Test Guide

## Overview
The Pi Browser now supports a "Scan to Pay" feature that lets merchants generate QR codes encoding just `flashpay:{paymentId}` format. Customers in Pi Browser can scan these codes to instantly view and pay the invoice.

## Architecture

### Merchant Side (Home Page)
1. Merchant enters amount on `/create` 
2. Generates payment record
3. On Home, sees two QR options:
   - **Standard QR**: Vercel URL (`https://flashpay.pi/pay/{id}`) - works everywhere
   - **Scan to Pay**: Pi Browser QR (`flashpay:{id}`) - optimized for Pi Network app

### Scanner Component (`PiBrowserScanner`)
- Encodes QR as: `flashpay:{canonical-UUID}`
- Supports three input methods:
  1. **Camera scan** (requests permission only when tapped)
  2. **Image upload** (scan from saved QR image)
  3. **Manual entry** (paste code or type UUID)
- Validates UUID format: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
- Extracts UUID and calls `onPaymentIdDetected(id)`

### Customer Side (Payment View)
1. Customer in Pi Browser scans `flashpay:uuid` QR
2. App extracts UUID from format
3. Renders existing `PaymentContentWithId` component with:
   - `paymentId={extractedUuid}`
   - `entry="pi"` (Pi Browser context)
4. Payment is fetched from backend by ID (authoritative source)
5. Customer completes payment using existing flow (no new payment record created)

## Test Scenario: Two Devices in Same Pi App Context

### Setup
- **Device A (Merchant)**: Pi Browser, logged in as merchant
- **Device B (Customer)**: Pi Browser, same App Studio context (`flashpay.pinet.com`)

### Test Flow

#### Step 1: Create Payment on Device A (Merchant)
```
Home Screen
→ "Scan to Pay (Pi Browser)" button
→ Scanner modal opens
→ (Or tap "Generate QR Code" first to create payment)
```

#### Step 2: Generate Scan QR on Device A
```
Amount: 10
"Generate QR Code"
→ Payment created (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)
→ Shows two QRs:
   1. Standard: https://flashpay.pi/pay/a1b2c3d4-e5f6-7890-abcd-ef1234567890
   2. Scan QR payload: flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

#### Step 3: Access Scanner on Device A
```
"Scan to Pay (Pi Browser)" button
→ PiBrowserScanner modal opens
→ Three options shown:
   - Start Camera Scan
   - Upload QR Image
   - Manual Entry (paste: flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890)
```

#### Step 4: Scan with Device B (Customer)
**Option A: Camera Scan**
- Device B scans QR generated on Device A
- Camera permission requested (on first tap only)
- UUID extracted: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
- Scanner closes

**Option B: Manual Entry**
- Device A shows: `flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890`
- Device B pastes into manual entry field
- Tap "Submit Code"
- UUID extracted and validated

#### Step 5: Payment View Renders on Device B (Customer)
```
App detects valid UUID from scan
Renders: <PaymentContentWithId 
  paymentId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  entry="pi"
/>
→ Fetches payment from backend (already exists from Device A)
→ Shows: 10π invoice to @merchantUsername
→ "Pay with Pi Wallet" button available
```

#### Step 6: Complete Payment
```
Device B: Tap "Pay with Pi Wallet"
→ Pi Network payment flow
→ On completion: status updates to PAID
→ Receipt shown
```

#### Step 7: Verify on Device A (Merchant)
```
Device A: Automatic updates or refresh
→ Payment status: PAID
→ Settlement tracks to merchant account
```

## Expected QR Values

### Standard QR (Vercel)
```
https://flashpay.pi/pay/a1b2c3d4-e5f6-7890-abcd-ef1234567890?amount=10&entry=web
```

### Scan to Pay QR (Pi Browser)
```
flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

## Key Testing Points

- [x] Hash-routing removed (only Vercel pathname `/pay/{id}`)
- [x] Scan QR encodes only `flashpay:{UUID}` (no URL/amount/note)
- [x] Camera permission requested only on first tap
- [x] Manual entry accepts exact `flashpay:` format
- [x] Invalid formats show error (never fall back to Home)
- [x] Scanned UUID renders existing `PaymentContentWithId`
- [x] No new payment record created on scan
- [x] Uses existing backend fetch and payment lifecycle
- [x] Pi entry mode (`entry="pi"`) respected
- [x] Settlement and status updates work as before
- [x] Two-device scenario: Device A creates, Device B scans and pays

## No Changes To

- Vercel QR generation and `/pay/{id]` pathname routing (unchanged)
- Pi SDK initialization and authentication (untouched)
- Payment approval/completion flow (no new logic)
- Recovery and settlement logic (no changes)
- Redis caching and persisted data (no changes)
- Admin/operations routes (no changes)
