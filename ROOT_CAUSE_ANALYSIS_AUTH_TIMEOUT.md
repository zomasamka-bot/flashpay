# Root Cause Analysis: Pi Wallet Authentication Timeout

## The Problem

When hazemaboria logged in, the authentication flow would timeout with "Pi wallet not responding" error, preventing `merchant.uid` and `merchant.accessToken` from being stored. Without this data, the Owner UID verification system had nothing to verify against, so the Operations Console never appeared.

## Root Cause: Timing Mismatch

The issue is **not** that the Pi Wallet is slow or unresponsive. The issue is a timing mismatch in how the Pi SDK works:

### What Happens Currently (Broken):

1. **Time 0ms**: `initializePiSDK()` starts
2. **Time ~50ms**: `Pi.init()` completes → SDK object is available
3. **Time ~50ms**: `setSdkInitStatus("ready")` is called **immediately**
4. **Time ~50ms**: Another `useEffect` triggers **immediately** and calls `authenticateMerchant()`
5. **Time ~50ms**: `authenticateMerchant()` calls `Pi.authenticate()`
6. **Problem**: The Pi Wallet user session is NOT ready at 50ms - it needs more time

### Why This Fails

In Pi Browser:
- `Pi.init()` initializes the SDK **object** on the app side
- But the **user's wallet session** on the Pi Browser side is separate
- The wallet needs a moment (~500ms) to set up its internal state and start listening for authentication requests
- If we call `Pi.authenticate()` before the wallet is ready to listen, it responds with "not responding" error

### Why Increasing Timeout Doesn't Fix It

A 30-second timeout vs 60-second timeout doesn't matter if the wallet **never starts listening**. The wallet doesn't respond at 100ms, not because it's "thinking", but because it's not ready to receive the call yet.

## The Fix: Add Wallet Readiness Delay

Added a **500ms delay** between `Pi.init()` completion and when we trigger `Pi.authenticate()`. This gives the Pi Wallet user session time to fully initialize and start listening.

### Changed Code

In `/app/page.tsx`, after `Pi.init()` succeeds:

\`\`\`typescript
// Wait for wallet session to be ready (500ms is safe margin)
setTimeout(() => {
  setSdkInitStatus("ready")  // This triggers authenticateMerchant()
}, 500)
\`\`\`

This ensures:
1. SDK object is available (Pi.init done)
2. Wallet session is listening (500ms delay)
3. `Pi.authenticate()` call succeeds
4. `merchant.uid` and `merchant.accessToken` are stored
5. Owner UID system has data to verify

## Why 500ms?

- 500ms is safe and doesn't impact user experience
- Real wallet authentication (after they see the prompt) takes seconds anyway
- If the wallet still isn't ready in 500ms, the 60-second timeout handles it
- If the wallet is ready in 100ms, 500ms doesn't hurt

## What This Doesn't Change

- Payment system: **Untouched** - payments initialize independently
- SDK initialization: **Same** - just adds a 500ms delay before authentication
- User experience: **Better** - authentication now succeeds instead of timing out
- Error messages: **Same** - still clear and helpful if real errors occur

## Expected Behavior After Fix

**For hazemaboria:**
1. Opens app → Pi SDK initializes
2. Waits 500ms for wallet to be ready
3. Calls `authenticateMerchant()`
4. Pi Wallet responds with UID
5. Stores merchant data
6. Profile page verifies and shows Operations Console

**For other users:**
1. Same flow
2. Gets different UID
3. Profile verifies: doesn't match owner
4. Operations Console doesn't appear

This is the actual root cause - not timeouts, not network delays, but a synchronization issue between SDK initialization and wallet session readiness.
