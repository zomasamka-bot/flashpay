# App Studio vs Vercel QR Code Test

## Implementation Summary

The App Studio QR defect has been fixed with hostname detection:

### Hostname Detection Logic
- **App Studio**: Hostname matches `demo-*.vusercontent.net` → Display Pi Browser QR (`flashpay:${UUID}`)
- **Vercel**: Hostname is `flashpay-two.vercel.app` → Display Vercel URL QR (`/pay/{id}`)

### Code Changes
1. **app/page.tsx** - Added hostname detection:
   ```typescript
   const isAppStudio = typeof window !== "undefined" && /^demo-.*\.vusercontent\.net$/.test(window.location.hostname)
   const visibleQRPayload = isAppStudio ? piBrowserQRPayload : paymentLink
   ```

2. **QR Display** - Conditional rendering:
   - App Studio: Shows "Scan with Pi Browser" + `flashpay:{UUID}` QR
   - Vercel: Shows "Scan QR Code to Pay" + `/pay/{id}` URL QR

3. **Scanner** (already complete):
   - jsQR for camera and image decoding
   - Validates exactly `flashpay:{canonical-UUID}` format
   - Stops after first valid result
   - Renders `PaymentContentWithId` with `paymentId={id}` and `entry="pi"`

## Two-Device Test Flow

### Setup
- **Device A (Merchant)**: App Studio or Vercel instance, create payment
- **Device B (Customer)**: Another device in same Pi app context

### Test Sequence

#### Scenario 1: App Studio (demo-*.vusercontent.net)
1. Device A creates payment with ID: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
2. Device A's merchant home displays QR with payload: `flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890`
3. Device B taps "Scan to Pay (Pi Browser)" button
4. Scanner requests camera permission → user grants
5. Device A holds up QR code to Device B's camera
6. jsQR decodes QR → extracts `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
7. Validator confirms `flashpay:` prefix and canonical UUID format
8. Scanner stops (first valid result)
9. Device B renders `PaymentContentWithId` with `paymentId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"` and `entry="pi"`
10. Device B sees payment screen with amount and Pi Wallet button
11. Device B completes payment via existing flow
12. Device A's merchant home updates to show "Payment Received!"

#### Scenario 2: Vercel (flashpay-two.vercel.app)
1. Device A creates payment
2. Device A's merchant home displays QR with payload: `https://flashpay-two.vercel.app/pay/{id}`
3. Device B taps "Scan to Pay" button OR scans with any QR reader
4. QR opens `/pay/{id}` route directly (Vercel routing)
5. Payment page loads and works as normal

#### Scenario 3: Image Upload Fallback
1. Device A creates payment
2. Device A screenshots the QR code
3. Device B taps "Upload QR" button in scanner
4. Device B selects screenshot from gallery
5. jsQR decodes image → extracts payment ID
6. Device B renders payment screen

#### Scenario 4: Manual Entry Fallback
1. Device B sees QR but can't scan
2. Device B taps "Enter Code Manually"
3. Device B enters: `flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890`
4. Validator confirms format
5. Device B renders payment screen

## Expected Logs

### App Studio (merchant creates payment)
```
[v0][QR] Generated QR payload: https://demo-abc123.vusercontent.net/pay/a1b2c3d4-e5f6-7890-abcd-ef1234567890
[v0][PiBrowserQR] Generated scan payload: flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890
[v0][Home] Hostname: demo-abc123.vusercontent.net
[v0][Home] Is App Studio: true
[v0][Home] Final QR payload: flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

### App Studio (customer scans)
```
[v0][PiBrowserScanner] QR data detected: flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890
[v0][PiBrowserScanner] Payment ID extracted: a1b2c3d4-e5f6-7890-abcd-ef1234567890
[v0][Home] Scanned payment ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890
[v0][Home] Will render PaymentContentWithId with entry=pi
```

### Vercel (merchant creates payment)
```
[v0][QR] Generated QR payload: https://flashpay-two.vercel.app/pay/a1b2c3d4-e5f6-7890-abcd-ef1234567890
[v0][PiBrowserQR] Generated scan payload: flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890
[v0][Home] Hostname: flashpay-two.vercel.app
[v0][Home] Is App Studio: false
[v0][Home] Final QR payload: https://flashpay-two.vercel.app/pay/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

## Result Screens

### App Studio - Merchant Home
- Display: "Scan with Pi Browser"
- QR Code shows: `flashpay:a1b2c3d4-e5f6-7890-abcd-ef1234567890`
- "Scan to Pay (Pi Browser)" button visible

### App Studio - Customer Payment
- After scan, renders `PaymentContentWithId`
- Screen shows: Amount in π, payment status, Pi Wallet button
- Payment flows through existing approval/settlement/settlement logic

### Vercel - Merchant Home
- Display: "Scan QR Code to Pay"
- QR Code shows: `https://flashpay-two.vercel.app/pay/{id}`
- Share/Copy buttons work with full URL

### Vercel - Customer Payment
- QR opens directly to `/pay/{id}` route
- Same payment screen renders via Vercel routing
- No scanner needed (direct URL navigation)

## No Changes To
- SDK authentication flow
- Payment approval/completion logic
- Redis data storage
- Settlement process
- Vercel QR/share functionality
- `/pay/[id]` route behavior
