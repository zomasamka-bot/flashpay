# Profile Authentication Troubleshooting Guide

## Summary of Changes

I have implemented Profile authentication based on the **exact same pattern** as `authenticateMerchant()` in `pi-sdk.ts`:

### Files Modified

1. **`/lib/profile-auth.ts`** - Complete rewrite to match `authenticateMerchant()` pattern
   - Now checks that Pi SDK is initialized (not just available)
   - Calls `window.Pi.authenticate()` with ["username", "payments", "wallet_address"] scopes
   - Properly extracts UID from multiple possible field names
   - Extracts and validates accessToken
   - Includes proper timeout and error handling

2. **`/app/profile/page.tsx`** - Added comprehensive logging
   - Logs before calling `authenticateForProfile()`
   - Logs the result from `authenticateForProfile()`
   - Logs UID values and NEXT_PUBLIC_OWNER_UID for comparison
   - Logs owner detection state on every render

## Testing Instructions

1. Deploy the updated code
2. Navigate to Profile page (behind password gate)
3. Click "Connect Wallet"
4. Authenticate in Pi Browser
5. **Open browser console (F12)** and look for `[v0]` prefixed logs

## What to Look For in Console

### Step 1: Wallet Connection Started
\`\`\`
[v0] Profile Connect Wallet started
[v0] Calling authenticateForProfile()...
\`\`\`

### Step 2: Authentication Result
\`\`\`
[v0] authenticateForProfile returned: {
  success: true/false,
  hasUid: true/false,
  hasAccessToken: true/false,
  username: "@piuser",
  error: null or error message
}
\`\`\`

**If success: false**
- Check the `error` field — it will say exactly what went wrong
- Possible errors:
  - "Pi SDK not available. Please open in Pi Browser."
  - "Pi SDK not initialized. Please refresh and try again."
  - "Authentication timeout - Pi wallet did not respond within 60 seconds"
  - "No user data returned from Pi Network"
  - "No user ID returned from Pi Network"
  - "No access token returned"
  - "No username returned"

### Step 3: UID Verification
If auth succeeded, you should see:
\`\`\`
[v0] Auth successful, setting username and verifying UID
[v0] UID to verify: [your-uid-first-20-chars]...
[v0] config.ownerUid: [expected-uid-first-20-chars]... or NOT SET
[v0] Calling verifyUid()...
[v0] verifyUid returned: { success: true/false, error?: ... }
\`\`\`

**If config.ownerUid is NOT SET**
- The NEXT_PUBLIC_OWNER_UID environment variable is not configured
- Owner features will never appear

**If verifyUid returned error**
- The API endpoint `/api/owner/verify-uid` rejected the UID
- Likely reason: your UID doesn't match NEXT_PUBLIC_OWNER_UID

### Step 4: Owner Detection
After wallet connection, you should see:
\`\`\`
[v0] Owner detection state: {
  uidDataStatus: "success",
  uidDataUid: "[your-uid-first-20-chars]...",
  configOwnerUid: "[expected-uid-first-20-chars]..." or "NOT SET",
  uidsMatch: true/false,
  isOwner: true/false,
  isConnected: true/false
}
\`\`\`

**Critical check: uidsMatch**
- If `uidsMatch: true` → isOwner should be `true` → Operations Console appears
- If `uidsMatch: false` → isOwner is `false` → Operations Console hidden

## How to Verify Ownership

1. Note your authenticated UID from the console
2. Check your NEXT_PUBLIC_OWNER_UID environment variable
3. They must match exactly (same string value)
4. If they don't match, you are not the owner

## Architecture Isolation

✅ **Completely isolated from payment system:**
- `profile-auth.ts` has zero dependencies on `unifiedStore`
- Reads wallet status only to verify SDK initialization (same as `authenticateMerchant`)
- Returns UID only to Profile page, not stored in payment-related storage
- `ownerUidStore` is completely separate from payment merchant state

✅ **Zero impact on payments:**
- `createPayment()` untouched
- `authenticateMerchant()` untouched
- Payment flow unaffected
- merchantId system unchanged

## Expected Behavior

**Non-owner user:**
1. Click Connect Wallet
2. Authenticate in Pi Browser
3. Toast says "Connected"
4. Wallet Connection card shows "Wallet Connected"
5. NO Operations Console appears
6. Console shows `uidsMatch: false` and `isOwner: false`

**Owner user (@hazemaboria with matching UID):**
1. Click Connect Wallet
2. Authenticate in Pi Browser
3. Toast says "Connected"
4. Wallet Connection card shows "Wallet Connected"
5. **Operations Console card appears with "Open Operations Console" button**
6. Console shows `uidsMatch: true` and `isOwner: true`

## Next Steps if Operations Console Doesn't Appear

1. Check browser console for all `[v0]` logs
2. Verify `uidsMatch: true` in owner detection state
3. Verify `config.ownerUid` is NOT "NOT SET"
4. If `uidsMatch: false`, compare your UID with expected owner UID
5. Share the console output for debugging
