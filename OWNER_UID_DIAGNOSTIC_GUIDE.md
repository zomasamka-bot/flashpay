# Owner UID Diagnostic Guide

## What Was Added

I have added comprehensive diagnostic logging to trace the owner verification flow at runtime. This will help identify where the process breaks.

### 1. Profile Page Logging (`/app/profile/page.tsx`)

**Verification Effect Logs:**
- When the effect runs, logs all conditions (mounted, merchantUid, accessToken, uidData.uid)
- Logs whether verification is triggered or why it's skipped
- Shows the first 20 chars of sensitive data (UID, token)

**Owner Detection Logs:**
Displays a detailed report showing:
\`\`\`
========== OWNER DETECTION REPORT ==========
Config Owner UID: [value or NOT SET]
config.isOwnerConfigured: true/false

Merchant UID: [value or NOT SET]
Access Token present: true/false

uidData Status: idle/pending/success/error
uidData.uid: [value or NOT SET]
uidData.error: [error message or NONE]

NEW SYSTEM CHECK:
  - status === 'success': true/false
  - uid !== null: true/false
  - uid === config.ownerUid: true/false
  - isOwnerFromNewSystem: true/false

OLD SYSTEM CHECK:
  - isOwnerFromOldSystem: true/false

FINAL RESULT:
  - isOwner: true/false
============================================
\`\`\`

### 2. API Endpoint Logging (`/app/api/owner/verify-uid/route.ts`)

**Request Phase:**
\`\`\`
========== OWNER VERIFY-UID REQUEST ==========
Request received
Config Owner UID: [value or NOT SET]
Received UID: [value or MISSING]
Access Token present: true/false
\`\`\`

**Validation Phase:**
- Logs if UID or token validation fails
- Shows which validation failed and returns appropriate error code

**Comparison Phase:**
\`\`\`
Comparing UIDs:
  - Provided UID: [full UID]
  - Config Owner UID: [full UID]
  - Match: true/false
\`\`\`

**Response Phase:**
- Logs success (200) or failure (403/400/500)
- Shows which error type is being returned

### 3. Hook Logging (`/lib/use-owner-uid.ts`)

**Verification Start:**
\`\`\`
========== VERIFY UID START ==========
UID to verify: [UID]
Access token present: true/false
\`\`\`

**API Call:**
- Logs when API is called
- Shows response status and ok flag
- Logs full response body

**Success Path:**
- Logs when verification succeeds
- Logs when data is stored
- Shows final stored state

**Error Path:**
\`\`\`
========== VERIFY UID FAILED ==========
✗ Verification failed: [error message]
\`\`\`

## How to Debug

### Step 1: Open Browser DevTools Console
- Press F12 or Cmd+Option+I
- Go to Console tab
- Look for logs starting with `[v0][Profile]`, `[API]`, `[useOwnerUid]`

### Step 2: Login as hazemaboria
- Go to home page
- Authenticate with Pi Wallet
- Navigate to Profile page
- Watch the console output in real-time

### Step 3: Trace the Flow

**Check each step in order:**

1. **Profile Effect Triggered?**
   - Look for: `[v0][Profile] Verification effect running:`
   - Check if all conditions are met (mounted, merchantUid, accessToken)
   - If conditions not met, check which one is missing

2. **API Called?**
   - Look for: `[v0][Profile] All conditions met - triggering verification`
   - Look for: `[useOwnerUid] Calling /api/owner/verify-uid`
   - If not called, check why conditions weren't met

3. **API Response?**
   - Look for: `[useOwnerUid] Response status:` (should be 200 if success)
   - Look for: `[useOwnerUid] Response body:` (should show `success: true`)
   - If not 200, check the API logs

4. **Owner Detection?**
   - Look for: `[v0][Profile] ========== OWNER DETECTION REPORT ==========`
   - Check if `isOwner: true` at the end
   - If false, trace why:
     - Does config.ownerUid match the UID you expect?
     - Does uidData.uid match what was returned from API?

## Critical Values to Check

### Expected Values for hazemaboria:

- `NEXT_PUBLIC_OWNER_UID` env var: `1a8127dc-34a2-442b-a58a-f12a78fe07c2`
- `config.ownerUid`: Should be `1a8127dc-34a2-442b-a58a-f12a78fe07c2`
- `merchant.uid` after login: Should be `1a8127dc-34a2-442b-a58a-f12a78fe07c2`
- `merchant.accessToken`: Should be a long string (JWT token)

### API Response (on success):
\`\`\`json
{
  "success": true,
  "walletAddress": "1a8127dc...f12a78fe",
  "isOwner": true,
  "timestamp": "2024-..."
}
\`\`\`

### Profile Owner Detection (on success):
\`\`\`
isOwnerFromNewSystem: true
isOwner: true
Operations Console card should be visible
\`\`\`

## What to Look For If It's Not Working

### Problem: merchantUid or accessToken missing
- **Check:** Are these fields present in the merchant data?
- **Solution:** Verify Pi SDK is properly initialized and merchant connected

### Problem: API not called
- **Check:** Look for `[v0][Profile] Verification conditions not met`
- **Solution:** One of the conditions is failing. Check which one.

### Problem: API returns 403 Unauthorized
- **Check:** Look for `[API] Comparing UIDs:`
- **Likely cause:** The config.ownerUid doesn't match the provided UID
- **Solution:** Verify NEXT_PUBLIC_OWNER_UID is correctly set in environment

### Problem: API returns 500
- **Check:** Look for `[API] ERROR: Owner UID not configured`
- **Likely cause:** config.ownerUid is empty or not set
- **Solution:** Verify NEXT_PUBLIC_OWNER_UID environment variable is defined

### Problem: UID verified but isOwner still false
- **Check:** Look at owner detection report
- **Check:** Verify `uidData.uid === config.ownerUid`
- **Likely cause:** One of these values doesn't match the other
- **Solution:** Compare the full values in console output

## Testing Checklist

- [ ] hazemaboria logs in
- [ ] Profile page loads
- [ ] Console shows verification logs starting
- [ ] API endpoint receives request with correct UID
- [ ] API returns 200 with success: true
- [ ] uidData.uid is populated
- [ ] config.ownerUid matches uidData.uid
- [ ] isOwner evaluates to true
- [ ] Operations Console card appears
- [ ] Other users don't see Operations Console card
- [ ] Payment system still works unchanged
