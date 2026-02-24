# CRITICAL DOMAIN CONFIGURATION FIX

## Root Cause Identified

Your payment QR codes use `pi://flashpay-two.vercel.app/pay/{id}` but Pi Network's Testnet requires payments to originate from your PiNet subdomain `flashpay0734.pinet.com`.

## Why This Causes "HostAppGateRoute Error"

Pi Network's payment gateway checks:
1. Is the payment request coming from an authorized domain?
2. For Testnet apps, authorized domain = `{subdomain}.pinet.com`
3. Your QR codes direct users to `flashpay-two.vercel.app` → Pi rejects with HostAppGateRoute error

## The Two Different URLs

**DO NOT CONFUSE THESE:**

### 1. Backend URL (in Pi Developer Portal)
- **Current:** `https://flashpay-two.vercel.app`
- **Keep it:** ✅ DO NOT CHANGE
- **Purpose:** Where Pi Network sends webhook calls (`/api/pi/approve`, `/api/pi/complete`)
- **This is correct and should remain Vercel**

### 2. App URL (NEXT_PUBLIC_APP_URL environment variable)
- **Current:** `https://flashpay-two.vercel.app` ❌ WRONG
- **Should be:** `https://flashpay0734.pinet.com` ✅ CORRECT
- **Purpose:** Where users access your app and make payments
- **Used in:** QR code generation, payment links, frontend routing

## How PiNet Subdomain Works

```
User scans QR → pi://flashpay0734.pinet.com/pay/xxx
                     ↓
              Pi Network Gateway (authenticates, authorizes)
                     ↓
              Routes to flashpay-two.vercel.app (your actual backend)
                     ↓
              Payment processes successfully
```

## The Fix

### Step 1: Add Environment Variable in Vercel

Go to Vercel Dashboard → flashpay → Settings → Environment Variables

**Add:**
```
NEXT_PUBLIC_APP_URL=https://flashpay0734.pinet.com
```

**For all environments:** Production, Preview, Development

### Step 2: Keep Portal Settings Unchanged

**Pi Developer Portal → Your App Settings:**
- Environment: Testnet ✅
- PiNet Subdomain: flashpay0734 ✅
- Backend URL: `https://flashpay-two.vercel.app` ✅ (DO NOT CHANGE)

### Step 3: Redeploy

After adding the environment variable, redeploy the app from Vercel.

## What This Changes

### Before (Broken):
```
QR Code: pi://flashpay-two.vercel.app/pay/abc123
User clicks Pay → Pi Network: "Unknown domain" → HostAppGateRoute Error
```

### After (Working):
```
QR Code: pi://flashpay0734.pinet.com/pay/abc123
User clicks Pay → Pi Network: "Authorized Testnet app" → Payment processes
```

## Why This Doesn't Break Webhooks

Pi Network sends webhooks to **Backend URL** (flashpay-two.vercel.app):
```
Pi Network → POST https://flashpay-two.vercel.app/api/pi/approve
Pi Network → POST https://flashpay-two.vercel.app/api/pi/complete
```

Your QR codes use **App URL** (flashpay0734.pinet.com):
```
User → https://flashpay0734.pinet.com/pay/abc123
       ↓ (Pi Network routes internally)
       → Serves content from flashpay-two.vercel.app
```

## Why Other Apps Work

Other Testnet payment apps:
- ✅ Use their PiNet subdomain for payment pages
- ✅ Use their hosting domain (Vercel/Netlify) for Backend URL
- ✅ Separate these two concerns

Your app (before fix):
- ❌ Used Vercel domain for BOTH payment pages AND webhooks
- ❌ Pi Network rejected payments not from `*.pinet.com`

## Verification After Fix

After redeploying, check logs:
1. QR code should show `pi://flashpay0734.pinet.com/pay/...`
2. User opens payment page → URL bar shows `flashpay0734.pinet.com`
3. User clicks Pay → Payment dialog appears (no HostAppGateRoute error)
4. Vercel logs show `/api/pi/approve` called with 200
5. Vercel logs show `/api/pi/complete` called with 200
6. Payment completes successfully

## Technical Explanation

The PiNet subdomain (`flashpay0734.pinet.com`) is a **reverse proxy** managed by Pi Network:

```
flashpay0734.pinet.com (Pi's proxy)
        ↓ (SSL termination, auth checks, payment authorization)
        ↓
flashpay-two.vercel.app (your actual server)
```

When a user makes a payment:
1. They're on `flashpay0734.pinet.com` (Pi-controlled domain)
2. Pi Network validates: "This is a registered Testnet app"
3. Payment proceeds through Pi's infrastructure
4. Pi sends webhooks to Backend URL (Vercel)
5. Success ✅

When a user tries to pay from `flashpay-two.vercel.app` directly:
1. They're on a non-Pi domain
2. Pi Network validates: "This domain not in our Testnet registry"
3. Payment blocked with HostAppGateRoute Error ❌

## This Is NOT a Pi Network Bug

This is **correct security behavior**. Pi Network only allows payments from registered domains (PiNet subdomains for Testnet, custom domains for Mainnet after approval).

Your app was trying to process payments from an unregistered domain (Vercel), which Pi correctly rejected.

## After Mainnet Approval (Step 10+)

Once you complete Step 10 and get flashpay.pi approved:
- App URL becomes: `https://flashpay.pi`
- Backend URL stays: `https://flashpay-two.vercel.app`
- QR codes use: `pi://flashpay.pi/pay/...`

Same pattern, just with your custom domain instead of PiNet subdomain.
