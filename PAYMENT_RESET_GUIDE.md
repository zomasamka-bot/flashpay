# Payment System Emergency Reset Guide

## Problem
The payment system is **BLOCKED** by a stuck pending payment that Pi Network won't release. This prevents any new payments from being created or processed, effectively freezing the entire payment flow.

**Symptoms:**
- App shows "A pending payment needs to be handled"
- Pi SDK rejects new payment attempts
- Payment creation fails even after code rollback
- Issue persists even if you clear browser data (because the payment is stored server-side in Redis)

**Why this happens:**
- A payment gets stuck in `PENDING` status in Redis
- Pi Network sees this pending payment and refuses to accept new ones
- The system can't automatically recover without manual intervention

---

## Solution: Payment System Reset

### Option 1: Use the UI Reset Panel (Recommended)

1. **Go to System Diagnostics:**
   - Open the app and click "System Diagnostics" (bottom of home page)
   - Or navigate to `/diagnostics`

2. **Find the "Payment System Status & Recovery" section**
   - You'll see current payment status (Pending, Paid, Failed counts)
   - Red alert if system is blocked

3. **Click "Clear Stuck Payments & Reset" Button**
   - Confirm when prompted
   - System will clear all pending payments from Redis
   - You'll see a success message

4. **System is now restored**
   - Payments can flow freely
   - Create new payment requests normally

---

### Option 2: Direct API Call (Diagnostic)

If you need to check or reset the system programmatically:

**Check current status:**
```bash
curl https://your-app-url/api/reset/payments
```

Response example:
```json
{
  "success": true,
  "totalPayments": 3,
  "byStatus": {
    "pending": 1,
    "paid": 2,
    "failed": 0
  },
  "isBlocked": true,
  "message": "⚠️ System BLOCKED: 1 pending payment(s) preventing new payments..."
}
```

**Reset the system (clear stuck payments):**
```bash
curl -X POST https://your-app-url/api/reset/payments
```

Response example:
```json
{
  "success": true,
  "message": "System reset complete. Cleared 1 stuck payment(s). Ready for new payments.",
  "paymentsCleaned": 1
}
```

---

## What the Reset Does

✅ **Clears all pending payments** from Redis storage  
✅ **Restores Pi Network payment flow** - Pi SDK will accept new payments  
✅ **Resets the system state** - Clean slate for new transactions  
✅ **Does NOT affect paid/completed** payments - Those are preserved  

---

## Important Notes

⚠️ **This is a destructive operation:**
- All pending (incomplete) payments will be permanently deleted
- Paid and failed payments are preserved
- You cannot undo this action
- Use only when the system is genuinely blocked

⚠️ **When to use:**
- System is completely blocked (can't create any new payments)
- Even after code rollback, the issue persists
- No legitimate pending payments that need to be recovered

---

## After Reset

1. **Verify System Health**
   - Go back to Diagnostics
   - Check that all counters show 0 or healthy numbers
   - Try creating a test payment

2. **Resume Normal Operation**
   - Create payment requests normally
   - Monitor payment status on Payments page
   - Watch for any recurring issues

3. **Report Recurring Issues**
   - If system blocks again frequently
   - Contact development team with logs
   - May indicate deeper issue with Pi SDK or server

---

## Technical Details

### Endpoint: `/api/reset/payments`

**GET** - Check system status
- Returns payment counts by status
- Indicates if system is blocked
- No side effects

**POST** - Execute reset
- Deletes all "pending" payments from Redis
- Clears KEYS matching "payment:*"
- Returns count of payments cleared

### Redis Keys Affected
- Pattern: `payment:*`
- All stuck pending payments are removed
- Fresh start for new payments

### Storage Location
- Payments are stored in Upstash Redis
- Also cached in browser localStorage (this is separate and unaffected)
- Reset only clears server-side Redis

---

## Preventing Future Blocks

1. **Monitor Payment Flow**
   - Check Payments page regularly
   - Watch for stuck pending payments

2. **Review Pi Network Limits**
   - Each app/merchant has a pending payment limit
   - Don't attempt too many simultaneous payments

3. **Handle Payment Lifecycle**
   - Always complete or cancel payments explicitly
   - Don't leave payments hanging indefinitely

4. **Keep Logs**
   - Check server logs for payment processing errors
   - May reveal systemic issues

---

## Troubleshooting

**Reset endpoint returns error:**
- Ensure Redis is configured (check env vars)
- Verify API key/token in Upstash
- Check network connectivity

**System still blocked after reset:**
- May indicate issue with Pi SDK itself
- Try reloading the page
- Check Pi Network status
- Contact support

**Can't access Diagnostics page:**
- Use direct API call: `POST /api/reset/payments`
- Check browser console for errors
- Verify you're running in Pi Browser

---

## API Response Codes

| Code | Meaning |
|------|---------|
| 200 | Success - Reset completed or status retrieved |
| 400 | Bad request - Invalid parameters |
| 500 | Server error - Redis not configured or connection failed |

---

## Questions?

For detailed help:
- Check `/diagnostics` page status in real-time
- Review server logs in Vercel dashboard
- Contact development team with:
  - When the block occurred
  - What you were trying to do
  - Count of pending payments
  - Any error messages seen
