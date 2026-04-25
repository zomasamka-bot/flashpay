## PAYMENT SYSTEM IS STUCK - IMMEDIATE FIX GUIDE

Your payment system is blocked by a stuck pending payment. Here are 3 ways to fix it immediately:

---

## Option 1: UI Reset Page (Easiest) ✅ RECOMMENDED

1. Open your FlashPay app
2. On the home page, scroll to the bottom
3. Click **"🔧 Payment Reset (if blocked)"**
4. The page will show:
   - Current payment status (Pending/Paid/Failed)
   - Number of stuck payments
5. Click **"Clear Stuck Payments & Reset"**
6. Confirm the action
7. ✅ System resets immediately - new payments can flow

**Status Indicators:**
- 🟢 **Green**: System is healthy, no reset needed
- 🔴 **Red**: System is blocked, click reset button

---

## Option 2: Direct API Call (If UI broken)

If the UI page doesn't load, use this directly from your terminal:

### Clear Stuck Payments:
```bash
curl -X POST https://your-app-url.vercel.app/api/reset/payments
```

You should get:
```json
{
  "success": true,
  "message": "System reset complete...",
  "paymentsCleaned": 1
}
```

### Check Status:
```bash
curl https://your-app-url.vercel.app/api/reset/payments
```

Response shows payment status and blocks status.

---

## Option 3: Emergency CLI Script

Only use this if both UI and API don't work. Requires Redis URL.

### Setup:
```bash
export KV_REST_API_URL="your-redis-url-from-vercel"
# OR
export REDIS_URL="redis://..."
```

### Run:
```bash
node scripts/emergency-reset.mjs
```

The script will:
1. Connect to Redis
2. List all stuck payments  
3. Ask for confirmation
4. Delete stuck payments
5. Verify the reset was successful

---

## What Happens During Reset?

✅ **Safe Operations:**
- Deletes only PENDING payments (stuck ones)
- Preserves all PAID transactions (safe)
- Preserves FAILED transactions (for audit)
- Clears the Pi Network blocking state

❌ **NOT Affected:**
- Your merchant account
- Transaction history (paid/failed kept)
- Payment settings
- Previous completed payments

---

## After Reset

1. The payment flow is immediately restored
2. New payments can be created right away
3. No "pending payment" blocking message
4. System is ready for normal operation

---

## Why Does This Happen?

A stuck pending payment occurs when:
- Pi Network accepts a payment but completion callback fails
- Network timeout during payment finalization
- Server crashes during payment webhook

Pi Network enforces: **Only 1 pending payment can exist at a time**

A stuck payment blocks new ones, requiring manual reset.

---

## Prevention for Future

The system now has:
✅ **Status Monitoring**: Auto-refreshes every 5 seconds
✅ **One-Click Reset**: Direct from app UI
✅ **Backup API**: Works if UI fails
✅ **Emergency Script**: Works if API fails

---

## Troubleshooting

**Problem**: Reset page shows "Something went wrong"
- Try Option 2 (direct API call)
- If that fails, try Option 3 (CLI script)

**Problem**: API returns 500 error
- Redis may be misconfigured
- Check KV_REST_API_URL env var in Vercel settings
- Verify Redis connection

**Problem**: Reset doesn't work
- Run the reset multiple times (sometimes Redis is slow)
- Check app logs for errors
- Verify Redis is accessible and not rate-limited

---

## Get Back to Work

Once reset is complete:

1. ✅ Refresh the FlashPay app
2. ✅ Connect your Pi Wallet (if needed)
3. ✅ Create test payment (amount = 0.01π)
4. ✅ Scan QR code in Pi Browser
5. ✅ Complete payment through Pi Wallet
6. ✅ Verify status updates to PAID

You're back in business! 🎉
