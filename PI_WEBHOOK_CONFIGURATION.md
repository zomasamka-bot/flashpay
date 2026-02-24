# Pi Network Webhook Configuration Guide

## Critical Issue: Payment Expires After 60 Seconds

Your payment flow is working correctly on the frontend, but Pi Network is showing "Payment expired / developer failed to approve this payment."

## Root Cause

The `/api/pi/approve` webhook is being called and responding with 200, but **Pi Network isn't receiving the response in time** or **the webhook URL is misconfigured in Pi Developer Portal**.

## Required Pi Developer Portal Configuration

### 1. Go to Pi Developer Portal
https://develop.pi/

### 2. Select Your App
Navigate to your FlashPay app

### 3. Configure Payment Callbacks

In the "App Settings" or "Payments" section, you MUST set these webhook URLs:

**Payment Approval Callback URL:**
```
https://flashpay-two.vercel.app/api/pi/approve
```

**Payment Completion Callback URL:**
```
https://flashpay-two.vercel.app/api/pi/complete
```

**Payment Cancellation Callback URL (optional):**
```
https://flashpay-two.vercel.app/api/pi/incomplete
```

### 4. Verify Webhook Accessibility

Test that Pi Network can reach your webhooks:

```bash
curl https://flashpay-two.vercel.app/api/pi/test-webhook
```

Should return:
```json
{
  "success": true,
  "message": "Pi webhook endpoint is accessible"
}
```

## Common Configuration Errors

### Error 1: Wrong Domain
❌ Using old domain: `flashpay0734.pinet.com`
✅ Use current domain: `flashpay-two.vercel.app`

### Error 2: Missing HTTPS
❌ `http://flashpay-two.vercel.app/api/pi/approve`
✅ `https://flashpay-two.vercel.app/api/pi/approve`

### Error 3: Wrong Path
❌ `/api/approve` or `/approve`
✅ `/api/pi/approve`

### Error 4: Not Configured at All
If you haven't set webhook URLs in Pi Developer Portal, Pi Network has no way to call your server to approve payments.

## Verification Checklist

- [ ] Webhook URLs are configured in Pi Developer Portal
- [ ] URLs use `https://flashpay-two.vercel.app` domain
- [ ] URLs include full path: `/api/pi/approve` and `/api/pi/complete`
- [ ] App is in "Development" or "Testnet" mode with webhooks enabled
- [ ] Test webhook endpoint returns success: `/api/pi/test-webhook`

## How Pi Payment Flow Should Work

1. **User clicks "Pay with Pi Wallet"** → Frontend calls `window.Pi.createPayment()`
2. **Pi Wallet opens** → User sees payment details and 60-second countdown
3. **User approves** → Pi Network calls `POST /api/pi/approve` (your webhook)
4. **Your server responds immediately** → `{success: true}` within milliseconds
5. **Pi processes blockchain** → Transaction submitted to Pi blockchain
6. **Blockchain confirms** → Pi Network calls `POST /api/pi/complete` (your webhook)
7. **Payment marked as PAID** → Customer sees success

## Current Status

Your code is correct and responds immediately (<100ms). The issue is **configuration**.

## Next Steps

1. **Check Pi Developer Portal** - Verify webhook URLs are configured
2. **Update if needed** - Use `https://flashpay-two.vercel.app/api/pi/...`
3. **Test the test endpoint** - Confirm Pi Network can reach your server
4. **Deploy again** - If you updated webhooks, test payment flow
5. **Check Vercel logs** - Look for `/api/pi/approve` being called BEFORE the 60-second timeout

## Expected Vercel Logs (Success)

```
[Pi Webhook] APPROVE ENDPOINT CALLED
[Pi Webhook] Response time so far: 50 ms
[Pi Webhook] RESPONDING TO PI NETWORK
[Pi Webhook] Total time before return: 52 ms
[Pi Webhook] Payment stored in KV (background)
```

If you see these logs WITHIN 60 seconds of user approval, the code is working. If you DON'T see these logs at all, Pi Network isn't calling your webhook = configuration issue.

## Support

If webhooks are configured correctly and you still see timeouts:
1. Check Vercel function logs for the exact timestamp of `/api/pi/approve` call
2. Compare to the timestamp when user clicked "approve" in Pi Wallet
3. The difference should be < 5 seconds

If the webhook is called 58-60 seconds after user approval, there's a network delay between Pi Network and Vercel that we cannot control.
