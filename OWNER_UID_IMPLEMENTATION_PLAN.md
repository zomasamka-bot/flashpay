# Owner UID Implementation Plan - Careful & Methodical

**Date**: June 30, 2026
**Status**: Analysis & Planning Complete - Ready for Implementation
**Risk Level**: GREEN (Completely Isolated)
**Payment System Impact**: NONE (Zero modifications to payment flow)

---

## Current System Analysis

### Existing Unified Architecture
- **Core System**: `lib/core.ts` - Locked, immutable
- **Unified Store**: `lib/unified-store.ts` - Single source of truth for payments + merchant state
- **Operations Layer**: `lib/operations.ts` - All operations go through here
- **React Hooks**: `lib/use-payments.ts`, `lib/use-merchant.ts` - Real-time updates
- **Pi SDK Integration**: `lib/pi-sdk.ts` - Handles authentication, payment creation
- **Routes**: `app/page.tsx` (home), `app/create/page.tsx`, `app/pay/[id]/page.tsx`, `app/payments/page.tsx`

### Current Merchant State (From Stable System)
\`\`\`typescript
// In lib/unified-store.ts:
interface MerchantState {
  merchantId: string
  uid: string              // Pi user UID
  piUsername: string       
  isSetupComplete: boolean
  walletAddress?: string
  accessToken?: string     // For A2U settlements
}
\`\`\`

### What Exists Today
1. ✅ Merchant authentication → stores `uid` in `unifiedStore.state.merchant.uid`
2. ✅ Payment creation → uses `uid` from merchant state
3. ✅ Pi wallet integration → handles A2U transfers
4. **❌ Owner-specific operations** → NOT YET BUILT

---

## Owner UID Feature Scope

### What is "Owner UID"?
A separate, isolated operational context for owner-specific tasks that:
- Does NOT interfere with merchant payment creation
- Does NOT touch the unified payment system
- Operates independently for future owner features (settlement, payouts, analytics)
- Uses same Pi authentication but separate operational context

### Files to Create (ISOLATED)

1. **`/lib/owner-uid-store.ts`** (NEW)
   - Independent storage for owner-specific state
   - Key: `"flashpay_owner_uid"` (separate from payments)
   - Stores: owner uid, access token, verification status
   - No dependencies on payment store

2. **`/lib/use-owner-uid.ts`** (NEW)
   - React hook for owner state
   - Exposes: `uidData`, `verifyUid()`, `isReady`, `error`
   - Subscribes to own store updates
   - No calls to payment operations

3. **`/app/api/owner/verify-uid/route.ts`** (NEW)
   - API endpoint for owner UID verification
   - Route: `/api/owner/verify-uid`
   - Independent from `/api/payments/*`
   - Read-only verification operation

4. **`/app/api/owner/status/route.ts`** (NEW - Optional)
   - Check owner verification status
   - Useful for debugging/diagnostics

### Files to NEVER TOUCH
- ❌ `lib/core.ts` - LOCKED
- ❌ `lib/operations.ts` - Payment operations only
- ❌ `lib/unified-store.ts` - Payment store only
- ❌ `lib/use-payments.ts` - Payment hooks only
- ❌ `lib/use-merchant.ts` - Merchant state only
- ❌ Any payment routes
- ❌ Any existing pages

---

## Implementation Strategy

### Phase 1: Storage Layer (Non-Reactive)
**File**: `/lib/owner-uid-store.ts`
- Simple object with getter/setter functions
- No React hooks at this level
- Uses localStorage with key `"flashpay_owner_uid"`
- Methods: `save()`, `load()`, `clear()`, `get()`

### Phase 2: React Hook Layer (Client-Side State)
**File**: `/lib/use-owner-uid.ts`
- Wraps storage layer in React hook
- Manages local state + subscriptions
- Methods: `verifyUid()`, `getCurrentUid()`, `isVerified()`
- No API calls at this level (just state management)

### Phase 3: API Layer (Server-Side Verification)
**File**: `/app/api/owner/verify-uid/route.ts`
- POST endpoint to verify owner UID with Pi Network
- Input: `{ uid: string, accessToken: string }`
- Output: `{ verified: boolean, error?: string }`
- No modifications to existing endpoints

### Phase 4: Testing (Verification Only)
- ✅ Verify payment system still works
- ✅ Verify no routes are broken
- ✅ Verify no blank pages
- ✅ Verify new owner API endpoint responds correctly

---

## Safety Guarantees

✅ **ZERO modifications** to existing system
✅ **Complete isolation** - separate storage keys, APIs, hooks
✅ **No breaking changes** - can be deleted completely without impact
✅ **Backward compatible** - existing payment flow unchanged
✅ **Easy rollback** - delete 3 files = system restored

---

## Implementation Order

1. **Step 1**: Create `/lib/owner-uid-store.ts` (storage layer)
2. **Step 2**: Create `/lib/use-owner-uid.ts` (react hook layer)
3. **Step 3**: Create `/app/api/owner/verify-uid/route.ts` (API layer)
4. **Step 4**: Verify payment system still works
5. **Step 5**: Test owner UID verification manually
6. **Step 6**: Document usage examples

---

## Success Criteria

✅ All 3 files created with real, working code (no placeholders)
✅ Payment system completely untouched
✅ No new errors in console
✅ Home page still loads and works
✅ Payment creation still works
✅ Public payment page still works
✅ Owner verification API responds correctly

---

## Next Action

Ready to proceed with Phase 1: Create storage layer.
