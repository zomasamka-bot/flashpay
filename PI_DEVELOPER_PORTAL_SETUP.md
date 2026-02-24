# Pi Developer Portal Configuration

## Critical Issue: Webhook URLs Not Being Called

If `/api/pi/approve` and `/api/pi/complete` are not being called by Pi Network, the issue is in your **Pi Developer Portal app configuration**.

## Required Configuration in Pi Developer Portal

### 1. App Settings

Go to: https://develop.pi/apps → Your App → Settings

**Backend URL (Platform API):**
```
https://flashpay-two.vercel.app
```

This tells Pi Network where to send webhook calls.

### 2. App Metadata

Ensure these are set:
- **Type:** `web` or `dapp`
- **Network:** `testnet` (for testing) or `mainnet` (production)
- **Payment enabled:** `Yes`

### 3. Webhook Endpoints

Pi Network automatically appends these paths to your Backend URL:

- **Approve:** `https://flashpay-two.vercel.app/api/pi/approve`
- **Complete:** `https://flashpay-two.vercel.app/api/pi/complete`
- **Cancel:** `https://flashpay-two.vercel.app/api/pi/cancel`

You don't manually configure these - Pi Network uses them automatically based on your Backend URL.

### 4. Required Environment Variables in Vercel

```bash
NEXT_PUBLIC_APP_URL=https://flashpay-two.vercel.app
PI_API_KEY=your_pi_api_key_from_developer_portal
```

## Testing the Configuration

### Test 1: Check if Backend URL is set

1. Go to Pi Developer Portal
2. Open your app settings
3. Verify "Backend URL" or "Platform API" field shows: `https://flashpay-two.vercel.app`

### Test 2: Verify webhook endpoints are accessible

Open these URLs in your browser - they should respond (not 404):

```bash
# Should return error about missing POST data, but endpoint exists
https://flashpay-two.vercel.app/api/pi/approve

# Should return error about missing POST data, but endpoint exists
https://flashpay-two.vercel.app/api/pi/complete
```

### Test 3: Check Vercel logs during payment

When user approves payment in Pi Wallet, you should see in Vercel logs:

```
[Pi Webhook] APPROVE CALLED
POST /api/pi/approve → 200
```

If you DON'T see these logs, Pi Network is not calling your backend = Backend URL not configured correctly.

## Common Issues

### Issue: "Payment expired / developer failed to approve"

**Cause:** Pi Network calls `/api/pi/approve` but doesn't receive 200 OK within 60 seconds

**Solutions:**
1. Verify Backend URL in Developer Portal matches your Vercel URL exactly
2. Check webhook endpoint responds with 200 OK immediately
3. Ensure no CORS blocking Pi Network's webhook calls

### Issue: Webhook endpoints never called

**Cause:** Backend URL not set in Developer Portal

**Solution:**
1. Go to Developer Portal → App Settings
2. Set "Backend URL" to `https://flashpay-two.vercel.app`
3. Save and test again

### Issue: Approve called but payment still expires

**Cause:** Endpoint takes too long to respond (>60 seconds)

**Solution:**
- Endpoint must respond within 1-5 seconds
- Our endpoint responds in <10ms - should not timeout
- Check Vercel function execution time in logs

## Verification Checklist

- [ ] Backend URL set in Pi Developer Portal: `https://flashpay-two.vercel.app`
- [ ] App approved and published in Developer Portal
- [ ] Payment permissions enabled for app
- [ ] `NEXT_PUBLIC_APP_URL` set in Vercel to `https://flashpay-two.vercel.app`
- [ ] Webhook endpoints accessible (return errors instead of 404)
- [ ] Test payment shows webhook calls in Vercel logs

## Next Steps

If webhook endpoints are STILL not being called after verifying all above:

1. **Create a new test payment**
2. **Check Vercel logs in real-time** (Vercel Dashboard → Your Project → Logs)
3. **Look for these specific lines:**
   ```
   [Pi Webhook] APPROVE CALLED
   [Pi Webhook] Pi Payment ID: xxx
   ```

4. **If you see NO webhook logs at all:**
   - Backend URL in Pi Developer Portal is wrong or missing
   - App not properly configured for payments
   - Need to contact Pi Network support

5. **If you see webhook logs but payment expires:**
   - Response timing issue (should be fixed in latest code)
   - Check actual response time in logs
