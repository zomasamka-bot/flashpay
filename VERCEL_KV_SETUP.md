# Vercel KV Setup Guide

## Problem Fixed

The "Payment Not Found" error was caused by using an in-memory store that doesn't persist across serverless function invocations. I've restored Vercel KV for proper persistence.

## Required Setup in Vercel Dashboard

### 1. Add Vercel KV to Your Project

1. Go to your Vercel project: https://vercel.com/dashboard
2. Select your `flashpay-two` project
3. Go to the **Storage** tab
4. Click **Create Database**
5. Select **KV (Redis)**
6. Name it: `flashpay-kv`
7. Click **Create**

### 2. Environment Variables (Auto-configured)

When you add KV storage, Vercel automatically adds these environment variables to your project:
- `KV_URL`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `KV_REST_API_READ_ONLY_TOKEN`

### 3. Add App URL Environment Variable

In your Vercel project settings:
1. Go to **Settings** → **Environment Variables**
2. Add this variable:
   ```
   NEXT_PUBLIC_APP_URL=https://flashpay-two.vercel.app
   ```
3. Make sure it's enabled for **Production**, **Preview**, and **Development**
4. Click **Save**

### 4. Redeploy

After adding KV storage and the environment variable:
1. Go to **Deployments** tab
2. Click the three dots on the latest deployment
3. Select **Redeploy**
4. Choose **Use existing Build Cache** is fine
5. Click **Redeploy**

## What This Fixes

✅ Payments are now stored in Vercel KV (persistent Redis database)
✅ QR codes contain the correct URL: `https://flashpay-two.vercel.app/pay/{id}`
✅ Payment retrieval works across serverless function invocations
✅ Multiple users can access different payments simultaneously

## How It Works

1. **Merchant creates payment** → Stored in KV with key `payment:{id}`
2. **QR code generated** → Contains `https://flashpay-two.vercel.app/pay/{id}`
3. **Customer scans QR** → Opens payment page
4. **Payment page loads** → Fetches payment from KV using the ID
5. **Customer pays** → Payment status updated in KV

## Pi Browser Deep Link

For the QR code to open directly in Pi Browser (not Chrome/Safari), you need to:

### Option 1: Pi Browser URL Scheme (Recommended)
Configure your app in the Pi Developer Portal:
1. Go to: https://develop.pi
2. Select your app
3. In **App Settings**, set:
   - **App URL**: `https://flashpay-two.vercel.app`
   - **Redirect URI**: `https://flashpay-two.vercel.app`

When users scan the QR with their phone camera:
- If Pi Browser is installed, it will open there
- Otherwise, it opens in the default browser

### Option 2: Custom URL Scheme (Advanced)
If you want to force Pi Browser, you need to register a custom URL scheme like:
```
pi://flashpay-two.vercel.app/pay/{id}
```

However, this requires:
- Configuration in Pi Developer Portal
- Pi Browser must recognize your domain
- May not work with all QR scanners

**Recommendation**: Use Option 1 (standard HTTPS URLs) as it provides the best user experience and works universally.

## Testing Checklist

After setup, test:
1. ✅ Create a payment (should see success message)
2. ✅ QR code displays
3. ✅ QR code contains correct URL
4. ✅ Scan QR with phone camera
5. ✅ Payment page loads (not "Payment Not Found")
6. ✅ Can initiate payment in Pi Browser

## Troubleshooting

### Still seeing "Payment Not Found"?
1. Check Vercel logs: `vercel logs`
2. Verify KV is connected in Storage tab
3. Ensure environment variables are set
4. Try a fresh deployment

### QR doesn't open in Pi Browser?
1. Verify app is registered at https://develop.pi
2. Check that App URL matches exactly
3. Ensure Pi Browser is installed on the phone
4. Try copying the link and pasting in Pi Browser manually

## Support

If you continue to see issues:
1. Check the Vercel deployment logs
2. Look for KV connection errors
3. Verify the payment ID in the QR matches the stored ID
