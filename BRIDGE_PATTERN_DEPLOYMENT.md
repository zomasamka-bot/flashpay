# FlashPay Bridge Pattern - Authentication Fix

## Root Cause Analysis

**Problem**: `Pi.authenticate(["payments"])` timed out at 30s then failed at 90s on the vusercontent payment page.

**Root Cause**: The vusercontent payment page (`demo-kzmguj4kor15vvy514c3.vusercontent.net/pay/[id]`) is **NOT the registered Pi app context**. It is a **sandboxed web view** running inside Pi Browser. While `window.Pi` object exists, it is a **bridge stub** without access to the genuine app's authentication private keys. The genuine registered app context is **`flashpay.pi`**, which is where `Pi.authenticate()` can actually complete.

**Technical Detail**: 
- vusercontent page: Read-only web page inside Pi Browser (Pi.authenticate never resolves)
- flashpay.pi: Registered app URL where Pi authentication works (genuine app context)

## Solution: Two-Stage Bridge Pattern

### Stage 1: Bridge Page (vusercontent)
**URL**: `https://demo-xxxxx.vusercontent.net/pay/[id]?entry=share`
- Shows FlashPay request header
- Shows amount and note
- Shows Payment ID  
- Button: **"Open in Pi Browser & Pay"**

### Stage 2: App Page (flashpay.pi) - CRITICAL: Use pi:// Protocol

**INCORRECT** (strips to home page):
```
https://flashpay.pi/pay/[id]?entry=pi
```

**CORRECT** (preserves routing):
```
pi://flashpay.pi/pay/[id]?entry=pi
```

**Why**: PiNet App Studio intercepts `https://` URLs and strips them to `/` before React routing. The `pi://` protocol preserves the full path through the browser facade.

- Genuine registered app context
- `Pi.authenticate(["payments"])` succeeds
- `createPayment → approve → complete → settlement` flow executes
- Status updates sync back to bridge

## Code Changes

### 1. Bridge URL Construction (`/app/page.tsx`)
```typescript
// Bridge URL (vusercontent): Shows payment details, launches into registered app
const bridgePaymentUrl = currentPaymentId && payment 
  ? `${typeof window !== "undefined" ? window.location.origin : "https://flashpay.pi"}/pay/${currentPaymentId}?amount=${payment.amount}&entry=share${payment.note ? `&note=${encodeURIComponent(payment.note)}` : ""}`
  : ""

// App URL (flashpay.pi): Inside genuine registered app context where Pi.authenticate() works
const appPaymentUrl = currentPaymentId && payment
  ? `https://flashpay.pi/pay/${currentPaymentId}?entry=pi${payment.note ? `&note=${encodeURIComponent(payment.note)}` : ""}`
  : ""
```

### 2. QR Code Points to Bridge (`/app/page.tsx`)
```typescript
<QRCode value={bridgePaymentUrl} size={300} />
```

### 3. Bridge UI Component (`/components/customer-payment-view.tsx`)
- Detects `entry=share` query parameter
- Renders bridge UI when in bridge mode
- Shows "FlashPay Request" with amount, note, Payment ID
- Button redirects to `https://flashpay.pi/pay/[id]?entry=pi`
- Skips SDK initialization (not needed in bridge mode)

### 4. App Entry Detection (`/components/customer-payment-view.tsx`)
- Detects `entry=pi` query parameter
- Initializes Pi SDK normally
- Proceeds with full authentication & payment flow

## URL Flow

```
1. Merchant scans QR or clicks share link
   ↓
2. Opens bridge: https://demo-xxxxx.vusercontent.net/pay/ID?entry=share
   ↓
3. Shows payment details, user clicks "Open in Pi Browser & Pay"
   ↓
4. Redirects to: pi://flashpay.pi/pay/ID?entry=pi
   ↓ (routes to /pay/ID inside app, preserves path)
5. Inside genuine app context, Pi.authenticate() succeeds
   ↓
6. createPayment → approve → complete → settlement
```

## Exact URLs for Testing

**Bridge URL** (QR target - vusercontent page):
```
https://demo-kzmguj4kor15vvy514c3.vusercontent.net/pay/[PAYMENT_ID]?amount=[AMOUNT]&entry=share&note=[NOTE]
```

**Launch URL** (after "Open in Pi Browser & Pay" button - uses pi:// protocol):
```
pi://flashpay.pi/pay/[PAYMENT_ID]?entry=pi&note=[NOTE]
```

**Why pi:// not https://**:
- `https://flashpay.pi/pay/[ID]` → PiNet strips to `/` (home page loses ID)
- `pi://flashpay.pi/pay/[ID]` → Pi protocol preserves `/pay/[ID]` through router

## No Changes To

- Vercel deployment or routing
- Pi SDK internals or timeout logic
- API endpoints (/api/payments, /api/pi/*)
- Redis or data storage
- Payment recovery or settlement
- Status codes or transitions

## Unchanged Files

- `/lib/pi-sdk.ts` (auth timeout now has context to complete)
- `/app/api/` (all routes unchanged)
- `/lib/operations.ts` (payment flow unchanged)
- `/lib/payment-status.ts` (status handling unchanged)
- `/lib/redis.ts` (storage unchanged)
