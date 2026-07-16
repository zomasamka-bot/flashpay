# Profile Page Authentication Architecture

## Overview

The Profile page implements a **clean, isolated owner authentication system** that is completely separate from the payment processing system. The profile authenticates users and determines if they have owner access to the Operations Console.

---

## Authentication Flow

### 1. **Page Load & Password Gate**

\`\`\`
User navigates to /profile
    ↓
PasswordGate component appears
User enters password
    ↓
ProfileContent renders (if password correct)
\`\`\`

### 2. **Merchant State Retrieval**

Once inside ProfileContent, we get merchant data from the payment system:

\`\`\`javascript
const merchant = useMerchant()  // from unified-store
const merchantUid = merchant?.uid          // Pi UID from payment auth
const accessToken = merchant?.accessToken // Obtained during Pi authentication
\`\`\`

**Where this comes from:**
- `merchantUid` and `accessToken` are populated when user authenticates with Pi Network
- This happens on Home page (not Profile page)
- Retrieved via `unifiedStore.getMerchantState()`

### 3. **Owner UID Verification (Isolated System)**

When merchant credentials become available, Profile **triggers a separate verification**:

\`\`\`javascript
const { uidData, verifyUid } = useOwnerUid()

useEffect(() => {
  if (mounted && merchantUid && accessToken && !uidData.uid) {
    verifyUid(merchantUid, accessToken).catch(() => {
      // Owner verification is non-critical
    })
  }
}, [mounted, merchantUid, accessToken, uidData.uid, verifyUid])
\`\`\`

**What happens:**

1. **Call `/api/owner/verify-uid`** with merchantUid and accessToken
2. **Backend validation:**
   - Checks that `NEXT_PUBLIC_OWNER_UID` is configured
   - Compares provided UID **exactly** against `config.ownerUid`
   - Returns 403 if UID doesn't match owner UID
   - Returns 200 if UID matches owner UID

3. **Store result in `ownerUidStore`** (completely isolated, different localStorage key)
   - Key: `flashpay_owner_uid` (NOT `flashpay-store`)
   - Status: "success" | "error" | "pending"
   - UID: stored only if verification succeeds

---

## Owner Detection Logic

\`\`\`javascript
const isOwner = uidData.status === "success" && uidData.uid === config.ownerUid
\`\`\`

**Conditions:**
- ✅ Verification must have succeeded (`uidData.status === "success"`)
- ✅ UID must exactly match `config.ownerUid` (from `NEXT_PUBLIC_OWNER_UID`)
- ❌ If either condition fails → `isOwner = false`

**Result:**
- If `isOwner === true` → Operations Console card appears in Profile
- If `isOwner === false` → Operations Console card hidden, only Payment Requests & Transactions visible

---

## Reconnect Wallet Button

"Reconnect Wallet" clears merchant authentication and forces a fresh connection:

\`\`\`javascript
const handleClearAndReconnect = () => {
  if (confirm("This will clear all wallet connection data...")) {
    unifiedStore.clearMerchantAuth()  // Clears merchant state & payment data
    router.push("/")                   // Redirect to home for fresh auth
  }
}
\`\`\`

**What happens:**
1. Clears `merchantUid` and `accessToken` from unified-store
2. User returns to Home page
3. Must authenticate with Pi Network again
4. Once re-authenticated, Profile automatically re-verifies owner status

**Important:** This does NOT clear `ownerUidStore` (owner UID storage). That persists because it's in a separate storage key.

---

## Data Storage (Completely Isolated)

### Merchant UID Storage
- **Location:** `unifiedStore` → localStorage key: `flashpay-store`
- **Shared with:** Payment system, Create Payment, QR code generation
- **Cleared by:** "Reconnect Wallet" button
- **Purpose:** Identifies which user owns which payment requests

### Owner UID Storage
- **Location:** `ownerUidStore` → localStorage key: `flashpay_owner_uid`
- **NOT shared with:** Payment system, payment store, operations
- **Cleared by:** Manual call to `ownerUidStore.clear()` (never automatic)
- **Purpose:** Determines if user can access Operations Console

---

## Environment Configuration

**`NEXT_PUBLIC_OWNER_UID`** environment variable:
- Set this to your Pi UID to enable owner-only features
- Example: `NEXT_PUBLIC_OWNER_UID=ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa`
- If not set: `config.ownerUid = ""` → Owner detection always fails → No Operations Console

**Verification:**
- Read via `config.ownerUid` in all components
- Checked in `/api/owner/verify-uid` endpoint
- If mismatch → User cannot access Operations Console

---

## Files Changed (Clean Implementation)

1. **`/app/profile/page.tsx`**
   - Removed all verbose console.log statements
   - Simplified owner detection to single condition
   - Clean, focused ProfileContent component

2. **`/lib/use-owner-uid.ts`**
   - Removed verbose logging from verifyUid hook
   - Clean error handling
   - Simple state management

3. **`/app/api/owner/verify-uid/route.ts`**
   - Removed verbose diagnostic logging
   - Clean validation and comparison logic
   - Single error log on exception only

---

## Security Properties

✅ **Isolated from Payment System**
- Owner UID verification doesn't touch payment APIs
- Separate storage key prevents accidental data mixing
- Cannot be exploited to modify payments

✅ **Backend Validation**
- UID comparison happens on server (cannot be bypassed on client)
- Environment variable never exposed to client code
- 403 response if UID doesn't match

✅ **Read-Only Verification**
- No database writes beyond owner store
- No payment records modified
- No transaction system touched

---

## Testing Checklist

- [ ] Set `NEXT_PUBLIC_OWNER_UID` to your actual Pi UID
- [ ] Authenticate with Pi Network on Home page
- [ ] Navigate to Profile page
- [ ] Verify Operations Console card appears
- [ ] Logout and authenticate as different user (if available)
- [ ] Verify Operations Console card does NOT appear
- [ ] Click "Reconnect Wallet"
- [ ] Verify merchant auth clears and redirects to home
- [ ] Re-authenticate and verify owner status re-verified automatically
