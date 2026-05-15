# A2U user_not_found Debugging Guide

## Problem
When payments are initiated from **Pi Browser (app context)**, A2U createPayment fails with:
```
user_not_found
```

But the same flow works perfectly when initiated from **Pi Developer Portal** (API context).

Key observation:
- `/v2/me` verification succeeds ✓
- User UID is returned ✓  
- U2A payment completes ✓
- A2U createPayment fails ✗

## Root Cause Hypothesis
The issue is likely a **UID scope or app context mismatch**:

1. **Pi Browser** runs the app in its embedded context with specific UID scope
2. **Pi API key** (used for A2U) was generated in different app context
3. The UID returned from Pi Browser's `/v2/me` may be valid for user authentication but not valid for A2U payment creation with this specific API key

## Logging Flow to Debug

### Stage 1: UID Extraction (Frontend → /api/payments)
**File**: `/lib/operations.ts` (lines 66-80)

Logs show:
```
[v0] unifiedStore.state.merchant: { merchantId, uid, accessToken, ... }
[v0] merchantUid value: (the exact UID being sent)
[v0] merchantUid type: string
[v0] merchantUid length: X
[v0] merchantUid has leading/trailing spaces: false/true
```

**What to check**:
- Is merchantUid populated? (should not be empty)
- Does it have correct length? (typically 24-32 chars)
- Any whitespace issues?

### Stage 2: Payment Creation API (/api/payments)
**File**: `/app/api/payments/route.ts` (lines 46-66)

Logs show:
```
[API] Extracted values:
[API]   - merchantUid: (value received from frontend)
[API]   - merchantUid length: X
[API]   - merchantUid has leading/trailing spaces: false/true
[API]   - accessToken: PROVIDED/MISSING
```

Later during Redis storage (lines 176-186):
```
[API] CRITICAL CHECK BEFORE REDIS STORAGE:
[API]   - Has merchantUid: true/false
[API]   - merchantUid type: string
[API]   - merchantUid length: X
[API]   - JSON includes 'merchantUid': true/false
```

**What to check**:
- merchantUid received correctly from frontend?
- Stored correctly in Redis?
- Any JSON serialization issues?

### Stage 3: A2U Creation Request (/api/pi/a2u)
**File**: `/app/api/pi/a2u/route.ts` (lines 61-80)

Logs show:
```
[Pi A2U] Full body: { paymentId, merchantId, merchantUid, accessToken, ... }
[Pi A2U] merchantUid value: (the UID being sent to Pi API)
```

Around line 276-306 (on Pi error):
```
[Pi A2U] ===== DEBUGGING user_not_found ERROR =====
[Pi A2U] Error code: user_not_found
[Pi A2U] UID sent to Pi API: (exact UID)
[Pi A2U] UID length: X
[Pi A2U] UID has leading/trailing spaces: true/false
[Pi A2U]
[Pi A2U] Payment object structure sent:
[Pi A2U]   - uid: (the UID Pi received)
[Pi A2U]
[Pi A2U] User context from /v2/me:
[Pi A2U]   - verified uid: (from /v2/me)
[Pi A2U]   - original merchantUid: (from payment)
[Pi A2U]   - UIDs match: true/false
[Pi A2U]
[Pi A2U] App context verification:
[Pi A2U]   - /v2/me app_id: (from /v2/me response)
[Pi A2U]   - NOTE: If user_not_found happens in Pi Browser but works in Dev Portal,
[Pi A2U]     the issue is likely UID scope or app context mismatch
```

## Debugging Checklist

When you see `user_not_found` from Pi API:

1. **Check UID consistency**
   - Does merchantUid stay same from frontend → payments API → a2u route?
   - Any whitespace or encoding changes?

2. **Check app context**
   - What is `/v2/me` app_id in Pi Browser?
   - What PI_API_KEY is configured? (belongs to same app?)
   - Is A2U enabled for this app in Pi settings?

3. **Check UID validity scope**
   - UID works for `/v2/me` ✓
   - UID works for U2A payment ✓
   - But fails for A2U with this API key ✗
   - This suggests: **UID is valid, but not authorized for A2U with this specific API key**

## Possible Solutions

### Solution 1: App Context Mismatch
If `/v2/me` app_id differs from PI_API_KEY's app:
- Verify PI_API_KEY belongs to the same app as the one running in Pi Browser
- Update env vars if needed

### Solution 2: A2U Not Enabled
If A2U is disabled for this app:
- Go to Pi Developer Portal
- Enable A2U for the app
- Verify API key has A2U permissions

### Solution 3: Testnet vs Production
If mixing Testnet and Production:
- Ensure UID, API key, and all endpoints are in same environment
- Testnet UIDs won't work with production API keys

## Log Collection for Support

When reporting the issue, include:
1. Full logs from `/lib/operations.ts` (UID extraction)
2. Full logs from `/app/api/payments/route.ts` (payment storage)
3. Full logs from `/app/api/pi/a2u/route.ts` (A2U failure including app context section)
4. Note: Works in Dev Portal? Works in Pi Browser?
5. Note: What is the actual UID value causing the error?
