# Profile State Debugging Guide

## Current Implementation Flow

1. **Profile.handleConnectWallet()**
   - Calls `authenticateForProfile()` → gets real UID + username
   - Sets `piUsername` state
   - Calls `verifyUid(uid, accessToken)` → sends to API

2. **verifyUid() in useOwnerUid hook**
   - Calls `ownerUidStore.setPending()` → notifies listeners
   - Sends request to `/api/owner/verify-uid`
   - If success: calls `ownerUidStore.setUid(uid, ...)` → notifies listeners
   - If error: calls `ownerUidStore.setError(...)` → notifies listeners

3. **ownerUidStore subscription in useOwnerUid hook**
   - On mount: subscribes to store changes
   - On any store change: calls `setUidData(ownerUidStore.getUid())`
   - This triggers Profile re-render with updated `uidData`

4. **Profile rendering**
   - `isConnected = uidData.status === "success"`
   - `isOwner = uidData.status === "success" && uidData.uid === config.ownerUid`
   - Button shows "Disconnect Wallet" if `isConnected`
   - Operations Console shows if `isOwner`

## Console Logs to Check

Deploy and open browser console (F12). Test Connect Wallet flow and look for:

### Phase 1: Authentication
\`\`\`
[v0] Profile Connect Wallet started
[v0] authenticateForProfile() → authResult with uid and username
[v0] piUsername set to: @hazemaboria
\`\`\`

### Phase 2: Verification
\`\`\`
[v0] verifyUid called with uid: xxxxx...
[v0] Calling /api/owner/verify-uid...
[v0] API response status: 200 or 403
[v0] API response result: {success: true/false, ...}
\`\`\`

### Phase 3: State Update
If API returns 200 (owner):
\`\`\`
[v0] Verification successful, storing UID...
[v0] UID stored, returning success
[v0] Profile state updated: {isConnected: true, isOwner: true}
\`\`\`

If API returns 403 (not owner):
\`\`\`
[v0] API returned error: 403
[v0] verifyUid error: Verification failed
[v0] Profile state updated: {isConnected: false, isOwner: false}
\`\`\`

## What Should Happen

✓ Connect Wallet button → button text changes to "Disconnect Wallet" (requires `isConnected = true`)
✓ Username shows in header and toast (requires successful auth)
✓ Operations Console appears (requires `isOwner = true` = API 200 response)

## If Button Doesn't Change

1. Check if `[v0] Profile state updated` shows `isConnected: true`
2. Check API response status (200 vs 403)
3. Check if store subscription is working by looking for multiple state update logs

## If Operations Console Doesn't Appear

1. Check if `isOwner: true` in logs
2. Check if provided UID matches `NEXT_PUBLIC_OWNER_UID` value
3. API response must be 200 for owner
