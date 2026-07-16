# Comprehensive Logging Setup for App ID Debugging

## What Was Added

Enhanced logging has been added at 3 critical points to track App ID differences between Developer Portal and Pi Browser:

### 1. Frontend: `lib/pi-sdk.ts` - `authenticateMerchant()`

**When runs**: When user clicks "Authenticate" in Pi Browser

**What it logs**:
\`\`\`
[MERCHANT-AUTH] ===== ENVIRONMENT CONTEXT =====
[MERCHANT-AUTH] typeof window: object
[MERCHANT-AUTH] window.location.href: https://app.pi/...
[MERCHANT-AUTH] document.referrer: ...
[MERCHANT-AUTH] typeof window.Pi: object

[MERCHANT-AUTH] ===== PI BROWSER ENVIRONMENT CHECK =====
[MERCHANT-AUTH] User-Agent: PiBrowser/...
[MERCHANT-AUTH] Pi SDK available: true
[MERCHANT-AUTH] Detected as Pi Browser: true

[MERCHANT-AUTH] ===== APP CONTEXT FROM AUTHENTICATION =====
[MERCHANT-AUTH] authResult.user.app_id: 695d44a6227530960816f8c6  (← THIS IS THE KEY VALUE)
[MERCHANT-AUTH] authResult.user.username: ...
[MERCHANT-AUTH] CRITICAL: The app_id above determines which app context...
[MERCHANT-AUTH] ⚠️  IMPORTANT: App ID = 695d44a6227530960816f8c6
\`\`\`

**Key value to save**: `authResult.user.app_id`

### 2. Frontend: `lib/operations.ts` - `createPayment()`

**When runs**: When merchant creates a payment

**What it logs**:
\`\`\`
[v0] ===== PAYMENT CREATION - UID EXTRACTION =====
[v0] unifiedStore.state.merchant: {...}
[v0] merchantId (merchantId field): ...
[v0] merchantUid (uid field): 1a8127dc-34a2-442b-a58a-f12a78fe07c2
[v0] merchantUid type: string
[v0] merchantUid length: 36
[v0] merchantUid has leading/trailing spaces: false

[v0] ===== PAYMENT CREATION - UID FLOW SUMMARY =====
[v0] Frontend Context (Pi Browser):
[v0]   - merchantUid from state = 1a8127dc-34a2-442b-a58a-f12a78fe07c2
[v0]   - accessToken available = YES
\`\`\`

**Key values to track**:
- `merchantUid`: The UID being sent to backend
- `accessToken`: Whether it's available

### 3. Backend: `app/api/pi/a2u/route.ts` - A2U Endpoint

**When runs**: When A2U payment is initiated (after customer pays)

**What it logs**:
\`\`\`
[Pi A2U] ===== VERIFYING UID WITH PI /V2/ME BEFORE CREATEPAYMENT =====
[Pi A2U] Payment ID: ...
[Pi A2U] Merchant UID to verify: 1a8127dc-34a2-442b-a58a-f12a78fe07c2
[Pi A2U] /v2/me verification SUCCEEDED

[Pi A2U] ===== FRESH /V2/ME RESPONSE AT A2U TIME =====
{
  "uid": "1a8127dc-34a2-442b-a58a-f12a78fe07c2",
  "app_id": "695d44a6227530960816f8c6",  (← COMPARE WITH PAYMENT CREATION APP_ID)
  "username": "...",
  ...
}

[Pi A2U] ===== APP_ID VERIFICATION =====
[Pi A2U] app_id from /v2/me: 695d44a6227530960816f8c6
[Pi A2U] NOTE: PI_API_KEY must belong to the same app_id

[Pi A2U] ===== UID COMPARISON =====
[Pi A2U] Verified UID from /v2/me: 1a8127dc-34a2-442b-a58a-f12a78fe07c2
[Pi A2U] Original merchantUid: 1a8127dc-34a2-442b-a58a-f12a78fe07c2
[Pi A2U] UIDs match: true

[Pi A2U] ===== SENDING TO PI PRODUCTION API (A2U Creation) =====
[Pi A2U] URL: https://api.minepi.com/v2/payments
\`\`\`

**Key values to track**:
- `app_id from /v2/me`: The app context during A2U
- `UIDs match`: Should be true

### 4. Backend: `app/api/pi/complete/route.ts` - Complete Webhook

**When runs**: After customer pays, before A2U is initiated

**What it logs**:
\`\`\`
[A2U-PRE-REQUEST] ===== DEBUGGING: DATA SENT TO A2U ENDPOINT =====
[A2U-PRE-REQUEST] Full existing payment from Redis: {...}
[A2U-PRE-REQUEST] merchantUid type: string
[A2U-PRE-REQUEST] merchantUid value (full): 1a8127dc-34a2-442b-a58a-f12a78fe07c2
[A2U-PRE-REQUEST] accessToken available: true
[A2U-PRE-REQUEST] accessToken first 50 chars: eyJ0...

[A2U-REQUEST] Request body being sent to A2U:
{
  "paymentId": "...",
  "merchantId": "...",
  "merchantUid": "1a8127dc-34a2-442b-a58a-f12a78fe07c2",
  "accessToken": "PROVIDED",
  "amount": 1,
  "memo": "..."
}

[A2U-REQUEST] ===== A2U DATA FLOW =====
[A2U-REQUEST] Sending to A2U:
[A2U-REQUEST]   - merchantUid: 1a8127dc-34a2-442b-a58a-f12a78fe07c2
[A2U-REQUEST]   - accessToken: YES (will verify with /v2/me)
\`\`\`

## How to Read the Logs

**When A2U fails with `user_not_found`:**

1. Open Vercel logs
2. Find the line: `[MERCHANT-AUTH] ⚠️  IMPORTANT: App ID = XXXXX`
   - Save this value (e.g., `695d44a6227530960816f8c6`)

3. Find the line: `[Pi A2U] app_id from /v2/me: XXXXX`
   - Compare with step 2

4. If they DON'T match:
   - ✅ Found the cause: Different App Context
   - PI_API_KEY belongs to different app_id

5. If they DO match:
   - Problem is elsewhere (check accessToken validity, etc.)

## Comparison Points

### Successful Case (Developer Portal)
\`\`\`
[MERCHANT-AUTH] App ID = 695ecb29ed46b43b6ec573cb
[Pi A2U] app_id from /v2/me: 695ecb29ed46b43b6ec573cb
↓ MATCHES ↓ A2U SUCCEEDS
\`\`\`

### Failed Case (Pi Browser)
\`\`\`
[MERCHANT-AUTH] App ID = 695d44a6227530960816f8c6
[Pi A2U] app_id from /v2/me: 695d44a6227530960816f8c6
↓ MATCHES ↓ But createPayment still fails
→ PI_API_KEY must belong to 695ecb29ed46b43b6ec573cb instead
\`\`\`

## Next Steps

1. Reproduce the failure from Pi Browser
2. Check Vercel logs for the values above
3. Compare App IDs
4. If different: Get PI_API_KEY from correct app in Pi Developer Portal
5. If same: accessToken or other issue (escalate)
