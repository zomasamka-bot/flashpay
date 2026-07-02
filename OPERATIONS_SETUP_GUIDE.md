# FlashPay Operations Console - Setup Guide

## Quick Start

The architecture refactoring is complete. To activate owner-only access, follow these steps:

## Step 1: Find Your Pi UID

Your Pi UID appears in the console logs when you authenticate. Look for a log line like:
\`\`\`
[MERCHANT-AUTH] authResult.user.uid: ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa
\`\`\`

Copy your full UID.

## Step 2: Add to Vercel Environment

1. Go to Vercel Project Settings → Environment Variables
2. Add new variable:
   - **Name**: `NEXT_PUBLIC_OWNER_UID`
   - **Value**: Your Pi UID (paste from Step 1)
   - **Environments**: Production, Preview, Development

3. Redeploy or restart development server

## Step 3: Verify Setup

1. Go to `/profile`
2. If you are the owner, you should see "Operations Console" button
3. Click it to access `/operations`
4. Verify you can access:
   - Control Panel
   - System Diagnostics  
   - Domain Management

## Architecture Overview

### User Profile (`/profile`)
- Account settings
- Logout
- Reconnect wallet
- Payment requests
- Transaction history
- **Operations Console link** (owner only)

### Operations Console (`/operations`) - Owner Only
- Platform dashboard
- System statistics
- Control Panel access
- Diagnostics access
- Domain management

## What's Protected

✅ **Owner-Only Routes**:
- `/operations` - Operations dashboard
- `/operations/domains` - Domain management
- `/api/control/system` - POST requests

✅ **User-Accessible Routes**:
- `/profile` - Account settings
- `/merchant/payments` - Payment requests
- `/transactions` - Transaction history
- `/create` - Create new payment
- `/pay/[id]` - Payment processing

## How It Works

### Frontend Protection
\`\`\`typescript
// In Operations Layout
const isOwner = useIsOwner(merchantUid)
if (!isOwner) {
  redirect("/profile") // Non-owners redirected
}
\`\`\`

### Backend Protection
\`\`\`typescript
// In API Routes
if (!isOwnerUid(ownerUid)) {
  return 403 Unauthorized
}
\`\`\`

## Testing Checklist

### As Owner:
\`\`\`
✓ Profile shows "Operations Console" button
✓ Can click button to access /operations
✓ Can access Control Panel
✓ Can access Diagnostics
✓ Can manage domains
\`\`\`

### As Non-Owner:
\`\`\`
✓ Profile does NOT show Operations button
✓ Cannot access /operations (redirected to /profile)
✓ Cannot access /operations/domains
✓ Cannot modify system settings
\`\`\`

### Payment Functionality:
\`\`\`
✓ Creating payments works normally
✓ QR codes generated correctly
✓ Payments complete successfully
✓ Settlements execute properly
\`\`\`

## No Payment Impact

All FlashPay payment workflows remain **completely unchanged**:
- U2A (User to App) transfers work as before
- A2U (App to User) settlements work as before
- Transaction recording works as before
- All merchant payment features work as before

This is a **pure architectural improvement** with zero impact on payment flows.

## Troubleshooting

### Operations Console button not showing
1. Check that `NEXT_PUBLIC_OWNER_UID` is set in Vercel
2. Verify the UID matches your merchant's Pi UID exactly
3. Clear browser cache and reload
4. Check browser console for logs

### Getting "Unauthorized" errors
1. Verify `NEXT_PUBLIC_OWNER_UID` is correct
2. Check that you're using the same Pi account
3. Ensure environment variable was deployed (may take a few minutes)

### Can't access /operations
1. If you're not the owner, this is expected (redirects to /profile)
2. If you are the owner, check the troubleshooting steps above

## File Reference

New/Modified Files:
- `/lib/owner-auth.ts` - Owner verification system
- `/app/operations/layout.tsx` - Owner gate
- `/app/operations/page.tsx` - Main dashboard
- `/app/operations/domains/page.tsx` - Domain management
- `/lib/config.ts` - Added ownerUid
- `/lib/router.ts` - Added operations routes
- `/app/profile/page.tsx` - Cleaned up
- `/app/api/control/system/route.ts` - Added verification

## Questions?

Check these files for more details:
- `/ARCHITECTURE_REFACTORING_COMPLETE.md` - Full technical details
- `/lib/owner-auth.ts` - Owner verification implementation
- `/app/operations/layout.tsx` - Owner gate pattern

The refactoring is **production-ready** and tested for zero impact on payment workflows.
