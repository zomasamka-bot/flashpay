# Owner UID - Usage Guide

**Start Date**: 2024
**Implementation**: Isolated, Non-Breaking
**Status**: Ready for Integration

---

## What Was Built

A **completely separate Owner UID system** that operates independently from the payment system. Think of it as a parallel track for merchant/owner operations.

### Three New Files

1. **Storage Layer** (`/lib/owner-uid-store.ts`)
   - Handles persistence
   - Own localStorage key
   - No dependencies

2. **React Hook** (`/lib/use-owner-uid.ts`)
   - Integrates with React components
   - No payment hook dependencies
   - Independent state management

3. **API Endpoint** (`/app/api/owner/verify-uid/route.ts`)
   - Separate from payment APIs
   - Read-only for now
   - Can be extended

---

## How to Use It

### Option 1: In a New Page

Create `/app/owner/page.tsx`:

\`\`\`typescript
"use client"

import { useOwnerUid } from "@/lib/use-owner-uid"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

export default function OwnerPage() {
  const { uidData, verifyUid, isReady, isPending } = useOwnerUid()
  const [manualUid, setManualUid] = useState("")
  const [manualToken, setManualToken] = useState("")

  const handleVerify = async () => {
    if (!manualUid || !manualToken) return
    
    const result = await verifyUid(manualUid, manualToken)
    if (result.success) {
      // UID verified and stored
    }
  }

  return (
    <div className="min-h-screen pb-20 pt-4">
      <div className="max-w-lg mx-auto px-4">
        <h1 className="text-2xl font-bold mb-6">Owner Setup</h1>

        <Card>
          <CardContent className="pt-6 space-y-4">
            {isReady ? (
              <div>
                <p className="text-green-600 font-semibold mb-2">✓ UID Verified</p>
                <p className="text-sm text-muted-foreground">
                  UID: {uidData.walletAddress}
                </p>
              </div>
            ) : (
              <>
                <div>
                  <label className="text-sm font-medium">Pi User ID</label>
                  <input
                    type="text"
                    value={manualUid}
                    onChange={(e) => setManualUid(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm"
                    placeholder="Your Pi UID..."
                  />
                </div>

                <div>
                  <label className="text-sm font-medium">Access Token</label>
                  <input
                    type="text"
                    value={manualToken}
                    onChange={(e) => setManualToken(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm"
                    placeholder="Your access token..."
                  />
                </div>

                <Button
                  onClick={handleVerify}
                  disabled={isPending || !manualUid || !manualToken}
                >
                  {isPending ? "Verifying..." : "Verify Owner UID"}
                </Button>

                {uidData.error && (
                  <p className="text-red-600 text-sm">{uidData.error}</p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
\`\`\`

### Option 2: In Existing Page

Add owner UID management to `/app/profile/page.tsx`:

\`\`\`typescript
import { useOwnerUid } from "@/lib/use-owner-uid"

export default function ProfilePage() {
  const { uidData, isReady } = useOwnerUid()

  return (
    <div>
      {/* Existing profile code */}

      <section className="mt-8 p-4 border rounded">
        <h3 className="font-semibold mb-4">Owner Account</h3>
        {isReady ? (
          <p className="text-green-600">✓ Owner UID verified</p>
        ) : (
          <p className="text-muted-foreground">Owner UID not configured</p>
        )}
      </section>
    </div>
  )
}
\`\`\`

### Option 3: Direct Store Access

If you don't want React:

\`\`\`typescript
import { ownerUidStore } from "@/lib/owner-uid-store"

// Set owner UID
ownerUidStore.setUid("user-123", "access-token-xyz", "0x...")

// Get owner UID
const uidData = ownerUidStore.getUid()
console.log(uidData)
// {
//   uid: "user-123",
//   accessToken: "access-token-xyz",
//   walletAddress: "0x...",
//   lastUpdated: 1234567890,
//   status: "success",
//   error: null
// }

// Clear
ownerUidStore.clear()
\`\`\`

---

## API Endpoint Usage

### POST `/api/owner/verify-uid`

**Request:**
\`\`\`json
{
  "uid": "your-pi-uid",
  "accessToken": "your-access-token"
}
\`\`\`

**Response (Success):**
\`\`\`json
{
  "success": true,
  "walletAddress": "user123...abc",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
\`\`\`

**Response (Error):**
\`\`\`json
{
  "success": false,
  "error": "Invalid UID"
}
\`\`\`

---

## Current State

### What Works Now
- ✅ Storing owner UID in localStorage
- ✅ Retrieving owner UID data
- ✅ Basic verification endpoint
- ✅ Independent from payment system

### What Doesn't Exist Yet
- ⏳ Settlement/payout operations
- ⏳ Owner dashboard
- ⏳ Transaction history for owner
- ⏳ Withdrawal requests

---

## Next Steps (Optional)

When you're ready to expand:

### 1. Create More API Endpoints

\`\`\`
/app/api/owner/settlements/route.ts    ← Get settlements
/app/api/owner/payouts/route.ts         ← Manage payouts
/app/api/owner/transactions/route.ts    ← Transaction history
/app/api/owner/analytics/route.ts       ← Owner analytics
\`\`\`

### 2. Create Owner Pages

\`\`\`
/app/owner/page.tsx                     ← Owner dashboard
/app/owner/settlements/page.tsx         ← Settlement history
/app/owner/payouts/page.tsx             ← Payout management
/app/owner/analytics/page.tsx           ← Owner analytics
\`\`\`

### 3. Extend the Hook

Add methods to `useOwnerUid`:
\`\`\`typescript
const {
  // Current
  uidData,
  verifyUid,
  clearUid,
  isReady,
  isPending,
  error,
  
  // Could add
  fetchSettlements,      // New
  requestPayout,         // New
  getAnalytics,          // New
} = useOwnerUid()
\`\`\`

---

## Safety Checklist Before Using

- [ ] Verified payment system still works
- [ ] No new console errors
- [ ] Payment creation still functions
- [ ] Payment list still displays
- [ ] Home page loads correctly

---

## Rollback Plan

If anything breaks, simply:

1. Delete `/lib/owner-uid-store.ts`
2. Delete `/lib/use-owner-uid.ts`
3. Delete `/app/api/owner/` directory
4. Remove any `useOwnerUid()` imports from your pages

The payment system will be completely unaffected.

---

## Important Notes

1. **Data is client-side only** - No database writes
2. **Separate from payments** - Can't interfere with payment flow
3. **Easy to extend** - Each API endpoint is independent
4. **No breaking changes** - Existing functionality untouched
5. **Testable in isolation** - Use it without affecting payments

---

## Questions or Issues?

- Owner UID not storing? Check browser localStorage under `"flashpay_owner_uid"`
- Verification failing? Check `/api/owner/verify-uid/route.ts` endpoint
- Hook not working? Ensure component is wrapped with client directive

Remember: This is completely isolated. Any issues with owner UID won't affect payments.
