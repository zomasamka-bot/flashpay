# Authentication Flow Fix - Owner UID System

## Problem Identified
The Owner UID feature depends on successful merchant authentication to get `merchant.uid` and `merchant.accessToken`. The issue was:

1. **Timeout too short**: 30 seconds was insufficient for Pi Wallet to respond, especially on slower connections
2. **No retry logic**: If authentication timed out, it failed silently and the app had no data
3. **Silent failure**: Users weren't informed that auth failed, so they didn't know why Owner features weren't working

## Root Cause
When the Pi SDK became ready, the app automatically called `authenticateMerchant()` on the home page (line 86-110). If this call timed out, it would fail silently without retrying, leaving `merchant.uid` and `merchant.accessToken` unset.

Later, when the Profile page tried to verify the Owner UID using the `/api/owner/verify-uid` endpoint, it had no data to work with, so the Owner check always failed.

## Fixes Applied

### Fix 1: Increased Authentication Timeout
**File**: `/lib/pi-sdk.ts` (lines 466-473)

Changed timeout from **30 seconds to 60 seconds**. This gives Pi Wallet more time to:
- Display authentication prompts
- Wait for user interaction
- Process permissions on slower connections

### Fix 2: Added Retry Logic
**File**: `/app/page.tsx` (lines 86-125)

Added intelligent retry mechanism:
- Detects retryable errors (timeout, "not responding")
- Retries up to 2 times with 2-second delays between retries
- Resets retry counter on success
- Logs retry attempts for debugging

### Fix 3: Graceful Degradation
**File**: `/app/page.tsx` (line 123)

If authentication fails completely:
- App continues working for receiving payments
- Users can still create payment requests without being authenticated as merchant
- No destructive toasts that would interrupt user experience

### Fix 4: Better Error Logging
**File**: `/lib/pi-sdk.ts` (lines 597-602)

Added detailed error logging to help diagnose authentication issues:
- Shows whether error is timeout, stuck payment, or something else
- Logs full error message for debugging

## How It Works Now

**Scenario: hazemaboria connects**
1. App loads → Pi SDK initializes (successful)
2. authenticateMerchant() is called
3. If timeout: retry after 2s (up to 2 times)
4. Once successful: `merchant.uid` and `merchant.accessToken` are stored in `unifiedStore`
5. Profile page can now verify these against `NEXT_PUBLIC_OWNER_UID`
6. Operations Console appears

**Scenario: Any other user connects**
1. Same process as above
2. `merchant.uid` is stored but doesn't match `NEXT_PUBLIC_OWNER_UID`
3. Profile page correctly denies Owner access
4. Operations Console doesn't appear

## No Impact on Payment System

- Zero modifications to payment API routes
- Zero modifications to payment creation logic
- Zero modifications to payment completion flow
- Authentication failure is graceful - app continues working

## What's Different Now

Before: Auth timeout → silent failure → no UID → Owner check broken
After: Auth timeout → retry 2x → success or graceful degradation → Owner check works if authenticated

## Testing Scenarios

**For hazemaboria:**
- Log in to app (authenticated as owner)
- Profile page shows Operations Console card
- Click Operations Console → /operations page loads
- Operations Console is fully accessible

**For other users:**
- Log in to app (authenticated as regular user)
- Profile page does NOT show Operations Console card
- Trying to access /operations directly → Access Denied page
- All payment functionality works normally

## Environment Check

Make sure NEXT_PUBLIC_OWNER_UID is set in your environment to the correct value for hazemaboria (1a8127dc-34a2-442b-a58a-f12a78fe07c2).
