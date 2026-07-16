# AccessToken Persistence Fix

## The Problem

In `/lib/pi-sdk.ts` line 575, accessToken was being stored incorrectly:

\`\`\`typescript
// BROKEN: Direct assignment bypasses storage persistence
unifiedStore.state.merchant.accessToken = accessToken
\`\`\`

This caused:
1. accessToken was set in memory only
2. NOT persisted to localStorage/storage
3. Subscribers (like Profile component) were NOT notified of the change
4. Profile component checked for both `merchant.uid` AND `merchant.accessToken` before running Owner UID verification
5. Since accessToken appeared to be undefined, Profile never ran verification
6. Operations Console never appeared, even for hazemaboria

## The Root Cause

The unified store has a proper update pattern:
- `updateMerchantState()` - Updates, saves to storage, AND notifies subscribers
- Direct assignment - Only updates in-memory, NO persistence, NO notification

MerchantState interface already includes the `accessToken?` field (line 48 of unified-store.ts), so the infrastructure was there—just not being used.

## The Fix

Changed line 575 in `/lib/pi-sdk.ts` from:
\`\`\`typescript
unifiedStore.state.merchant.accessToken = accessToken
\`\`\`

To:
\`\`\`typescript
unifiedStore.updateMerchantState({ accessToken })
\`\`\`

This ensures:
1. accessToken is stored in memory
2. **PERSISTED to storage** (saveToStorage called internally)
3. **Subscribers are notified** (notify() called internally)
4. Profile component receives the update via subscription
5. Profile now has both uid AND accessToken available
6. Profile can verify Owner UID and show Operations Console

## Impact

- **Single line change** in `/lib/pi-sdk.ts`
- **Payment system**: Completely untouched - no impact on payment flow
- **Owner UID system**: Now works correctly because Profile has both uid and accessToken
- **Storage**: accessToken now persists across page reloads
- **Subscribers**: Profile component now receives updates when accessToken changes

## How It Works Now

1. User clicks "Connect Wallet" → authenticateMerchant() called
2. Pi.authenticate() succeeds → gets uid and accessToken
3. completeMerchantSetup() stores uid and persists it
4. updateMerchantState({ accessToken }) stores, persists, and notifies
5. Profile component receives notification via subscription
6. Profile sees both merchant.uid and merchant.accessToken available
7. Profile triggers Owner UID verification with both values
8. If uid matches NEXT_PUBLIC_OWNER_UID → Operations Console appears
9. If uid doesn't match → Operations Console stays hidden

## Testing

- hazemaboria connects → Operations Console appears
- Other users connect → Operations Console stays hidden
- Payment flow: unchanged
