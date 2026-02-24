# CRITICAL: Vercel KV Setup Required

## Current Issue

Your app is deployed to Vercel but **payments are not persisting** between requests. This is because:

1. **Vercel KV is not configured** in your project
2. The app is using in-memory storage which **does NOT work** in serverless environments
3. Each API request can hit a different serverless function instance with its own empty memory

## Why This Happens

Vercel deploys your API routes as serverless functions. Each function instance has its own memory:

```
Request 1 (Create Payment) → Function Instance A → Stores in Memory A
Request 2 (Get Payment)    → Function Instance B → Memory B is empty → 404 Not Found
```

## Required Fix: Add Vercel KV

### Step 1: Add KV to Your Vercel Project

1. Go to your Vercel dashboard: https://vercel.com/dashboard
2. Select your `flashpay-two` project
3. Click **Storage** tab
4. Click **Create Database**
5. Select **KV (Redis)**
6. Name it: `flashpay-kv`
7. Click **Create**

### Step 2: Connect KV to Your Project

After creating the KV database:

1. Vercel will show you environment variables
2. Click **Connect to Project**
3. Select your `flashpay-two` project
4. This automatically adds these environment variables:
   ```
   KV_REST_API_URL=https://...
   KV_REST_API_TOKEN=...
   KV_REST_API_READ_ONLY_TOKEN=...
   ```

### Step 3: Redeploy

1. Push a small change to trigger a new deployment
2. Or click **Redeploy** in Vercel dashboard
3. Make sure the deployment completes successfully

### Step 4: Verify

After redeployment, check the logs. You should see:

```
[API] KV Configuration Status:
[API] - KV_REST_API_URL: Set
[API] - KV_REST_API_TOKEN: Set
[API] - isKvConfigured: true
[API] ✅ Payment stored in Vercel KV: <payment-id>
```

## How to Check if KV is Working

### Method 1: Check Logs (Recommended)

When you create a payment, check Vercel logs for:

**✅ Good (KV Working):**
```
[API] Storage mode: Vercel KV
[API] ✅ Payment stored in Vercel KV: abc-123
[API] Verification read: SUCCESS
```

**❌ Bad (KV Not Working):**
```
[API] Storage mode: In-Memory (DEV ONLY)
[API] ⚠️ Storing to in-memory (WILL NOT PERSIST)...
```

### Method 2: Create and Retrieve Payment

1. Create a payment in the app
2. Copy the QR code URL (contains payment ID)
3. Open that URL in a new browser tab
4. **If you see "Payment Not Found"** → KV is not configured
5. **If you see the payment details** → KV is working!

## Authentication Scope Issue

The authentication issue you're experiencing is separate. I've added extensive logging to the Pi SDK authentication flow. When you attempt payment, check the logs for:

```
[v0] ========== AUTHENTICATION COMPLETED ==========
[v0] authResult.user.scopes: [...]
```

If scopes are missing, this indicates a Pi SDK or Pi Browser issue, not a server issue.

## Cost

Vercel KV has a free tier that includes:
- **256 MB storage** (plenty for testing)
- **10,000 commands per day**
- **Up to 3 databases**

Your payment app will likely use <1MB storage for thousands of payments.

## Alternative: Neon PostgreSQL

If you prefer a SQL database:

1. Go to https://neon.tech
2. Create a free account
3. Create a database
4. Copy the connection string
5. Add to Vercel: `DATABASE_URL=postgresql://...`
6. Update the API code to use Postgres instead of KV

But for this simple payment app, **KV is the fastest and easiest solution**.

## Need Help?

After setting up KV:
1. Redeploy your app
2. Try creating a payment
3. Check the Vercel logs for the verification messages
4. If it still doesn't work, share the logs and I'll help debug further
