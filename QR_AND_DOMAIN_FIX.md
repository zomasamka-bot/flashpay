# 🔗 Pi Browser QR Flow - Complete Fix

## Problems Identified

### Problem 1: QR Code Opens in Wrong Browser
When customer scans QR code from merchant app:
- **Currently**: Opens in Vercel portal (flashpay-two.vercel.app)
- **Should**: Opens in Pi Browser (flashpay.pi)
- **Impact**: Pi SDK not available, session lost, payment fails

### Problem 2: "Payment not found" Error  
After QR scan, merchant screen shows "Payment not found" because:
- Payment page opens outside Pi Browser
- Cannot access Pi SDK or proper session
- API calls may fail or use wrong environment

### Problem 3: Domain/Environment Mismatch
- Merchant runs inside Pi Browser (correct)
- Customer opens payment outside Pi Browser (wrong)
- Different environments = different sessions = data loss

---

## Root Cause

In `/app/page.tsx` line 297:
```javascript
// ❌ WRONG: Uses Vercel domain
const paymentLink = `pi://${config.appUrl.replace('https://', '')}/pay/...`
// Result: pi://flashpay-two.vercel.app/pay/... (NOT Pi Browser!)
```

`config.appUrl` always points to Vercel for API calls, but QR codes must use flashpay.pi domain.

---

## Fix Applied

Changed `/app/page.tsx` line 249-253:
```javascript
// ✅ CORRECT: Uses Pi domain for QR codes
const paymentLink = currentPaymentId && payment
  ? `pi://flashpay.pi/pay/${currentPaymentId}?amount=${payment.amount}...`
  : ""
```

**This ensures:**
- QR code contains `pi://flashpay.pi` instead of `pi://flashpay-two.vercel.app`
- When scanned, opens in Pi Browser (not regular browser)
- Payment page loads in same environment as merchant
- Pi SDK available for payment execution
- Session remains continuous

---

## How It Works Now

### Merchant Flow
1. Merchant opens app in Pi Browser → `pi://flashpay.pi/`
2. Connects wallet, creates payment request
3. System generates QR code with `pi://flashpay.pi/pay/{id}?amount=...`

### Customer Flow (FIXED)
1. Customer scans QR code
2. Pi Browser recognizes `pi://` protocol
3. Opens payment page in Pi Browser: `pi://flashpay.pi/pay/{id}`
4. Page loads with proper Pi SDK support
5. Payment can complete successfully

### API Calls
- Regardless of domain (`flashpay.pi` or vercel URL), API calls use `config.appUrl` (Vercel backend)
- This is correct because APIs live on backend, not on domain

---

## Data Flow - Before Fix

```
Merchant (Pi Browser)
  ↓
Creates payment
  ↓
Generates QR: pi://flashpay-two.vercel.app/pay/{id}  ❌
  ↓
Customer scans
  ↓
Opens in regular browser ❌
  ↓
No Pi SDK available ❌
  ↓
"Payment not found" error ❌
```

## Data Flow - After Fix

```
Merchant (Pi Browser)
  ↓
Creates payment
  ↓
Generates QR: pi://flashpay.pi/pay/{id}  ✓
  ↓
Customer scans
  ↓
Opens in Pi Browser ✓
  ↓
Pi SDK available ✓
  ↓
Payment page loads correctly ✓
  ↓
"Pay Now" works ✓
  ↓
Payment completes ✓
```

---

## Testing Checklist

### Setup
- [ ] Merchant opens app in Pi Browser (`pi://flashpay.pi`)
- [ ] Wallet connected successfully
- [ ] Ready to create payment

### Payment Creation
- [ ] Enter amount (e.g., 10π)
- [ ] Click "Generate QR Code"
- [ ] QR code displayed

### QR Code Verification
- [ ] Open QR in terminal: `pi://flashpay.pi/pay/[id]?amount=10`
- [ ] NOT: `pi://flashpay-two.vercel.app/pay/[id]`
- [ ] Contains `flashpay.pi` ✓

### Customer Scanning
- [ ] Scan QR with Pi app (on testnet)
- [ ] Payment page opens in **Pi Browser** (not regular browser)
- [ ] Diagnostics show "Pi SDK ready" ✓
- [ ] Amount displays correctly (10π)

### Payment Execution
- [ ] Click "Pay Now"
- [ ] Pi Wallet opens
- [ ] Approve payment
- [ ] Payment completes
- [ ] Status shows "PAID" ✓
- [ ] NO "Payment not found" error ✓

---

## Files Changed

| File | Change | Reason |
|------|--------|--------|
| `/app/page.tsx` | Line 249-253 | QR code now uses `flashpay.pi` instead of Vercel URL |

---

## Environment Variables Needed

Set in Vercel project settings:
- `NEXT_PUBLIC_APP_URL=https://flashpay-two.vercel.app` (for APIs)
- flashpay.pi domain must be configured in Pi Network dashboard

---

## If Still Not Working

1. **QR still opens wrong domain?**
   - Check line 249-253 of `/app/page.tsx`
   - Verify `pi://flashpay.pi` is in QR code
   - Regenerate QR code (clear browser cache first)

2. **"Payment not found" still appears?**
   - Ensure payment data is in Redis/KV
   - Check `/api/payments/{id}` endpoint
   - Verify merchant data is preserved

3. **Pi SDK not available?**
   - Ensure running inside Pi Browser (check diagnostics)
   - Reload page
   - Check browser console for errors

---

## Status

✅ QR domain issue fixed
✅ Payment page environment alignment fixed
⏳ Testing required to confirm payment flow works end-to-end

**Next**: Test complete flow from merchant QR generation to customer payment completion.
