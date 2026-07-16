# Profile Owner Detection Debug Guide

## Changes Made

### 1. Fixed Generic Text
- Changed wallet connection prompt from "Connect your Pi Wallet to access profile features and owner operations"
- To: "Connect your Pi Wallet to access your profile features"
- This text is now generic for all users regardless of owner status

### 2. Added Comprehensive Debug Logging

#### In Profile (`/app/profile/page.tsx`):
- Added owner detection state logging on every render showing:
  - Current uidStatus
  - Current UID value (truncated)
  - Configured owner UID (truncated)
  - Whether isOwner condition is true
  - Whether isConnected condition is true
- Added detailed logging in `handleConnectWallet()`:
  - After authenticateMerchant() call
  - When retrieving merchantState
  - Before calling verifyUid()
  - After verifyUid() completes

#### In Owner UID Store (`/lib/owner-uid-store.ts`):
- Added logging when setUid() is called showing what's being stored

#### In Verify-UID API (`/app/api/owner/verify-uid/route.ts`):
- Added logging showing the UID comparison
- Shows which UID was provided vs configured
- Shows match result

#### In useOwnerUid Hook (`/lib/use-owner-uid.ts`):
- Added logging after API succeeds showing state update

## How to Debug

1. **Open Browser DevTools Console** (F12)

2. **Navigate to Profile page** and log in with password

3. **Click "Connect Wallet"**
   - Watch for `[v0] authenticateMerchant result:` log
   - Should show `success: true` and your Pi username

4. **In Pi Browser**
   - Approve the authentication request

5. **Check logs in this order**:
   - `[v0] authenticateMerchant result:` - should be successful
   - `[v0] merchantState retrieved:` - should have uid and accessToken
   - `[v0] Calling verifyUid...` - should appear before API call
   - `[v0] verify-uid API - comparing UIDs:` - check if both UIDs match
   - `[v0] useOwnerUid - API returned success` - should appear if API returned success
   - `[v0] OwnerUID store setUid:` - should show UID being stored
   - `[v0] Owner Detection State:` - should show updated isOwner status

## Expected Behavior

### For Owner User (uid === NEXT_PUBLIC_OWNER_UID):
1. Connect Wallet button visible until authenticated
2. After authentication:
   - Username displays in header
   - "Disconnect Wallet" button appears
   - **Operations Console card should appear** with "Open Operations Console" button
   - Logs should show: `match: true` in verify-uid API log

### For Non-Owner User:
1. Connect Wallet button works normally
2. After authentication:
   - Username displays in header
   - "Disconnect Wallet" button appears
   - **Operations Console card should NOT appear**
   - Logs should show: `match: false` in verify-uid API log

## Quick Checklist

- [ ] wallet connection text is now generic
- [ ] Debug logs appear in browser console
- [ ] Verify UIDs show in comparison log
- [ ] Check if ownerUid environment variable is set correctly
- [ ] Confirm your Pi UID matches NEXT_PUBLIC_OWNER_UID value
- [ ] Check browser localStorage for `flashpay_owner_uid` key after authentication

## Files Modified

1. `/app/profile/page.tsx` - Fixed text + added comprehensive logging
2. `/lib/owner-uid-store.ts` - Added logging in setUid()
3. `/app/api/owner/verify-uid/route.ts` - Added UID comparison logging
4. `/lib/use-owner-uid.ts` - Added state update logging
