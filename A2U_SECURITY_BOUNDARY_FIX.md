# A2U Security Boundary Enforcement - Critical Fixes Applied

**Date**: 2026-01-17  
**Status**: ✅ COMPLETED  
**Severity**: CRITICAL - Prevents unauthorized merchant data exposure

## Summary

Implemented strict security boundaries for the A2U (App-to-User) settlement endpoint to prevent merchant data injection and ensure only verified Redis payment records are used for settlement accounting.

## Critical Changes

### 1. A2U Request Validation - `/app/api/pi/a2u/route.ts`

**Added strict request body validation:**
- New function `validateA2URequestBody()` ensures request contains **EXACTLY** one key: `paymentId`
- Rejects any request with additional fields (merchantId, amounts, UIDs, tokens, settlement data, etc.)
- Fails closed with detailed security logging if validation fails
- All merchant data must come ONLY from verified Redis payment record, never from request body

**Before:**
```typescript
interface A2UPaymentRequest {
  paymentId: string
}
const { paymentId } = body
if (!paymentId) return error
```

**After:**
```typescript
interface A2UPaymentRequest {
  paymentId: string
}

function validateA2URequestBody(body: unknown): body is A2UPaymentRequest {
  if (!body || typeof body !== "object") return false
  const keys = Object.keys(body as Record<string, unknown>)
  if (keys.length !== 1) {
    console.error("[Pi A2U] Request body has", keys.length, "keys, expected exactly 1")
    return false
  }
  if (!keys.includes("paymentId")) return false
  const req = body as Record<string, unknown>
  if (typeof req.paymentId !== "string" || !req.paymentId) return false
  return true
}

// Usage
if (!validateA2URequestBody(body)) {
  return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
}
```

### 2. Client Payment Creation - `/lib/operations.ts`

**Removed merchant data from payment creation request:**
- Client no longer sends `merchantId`, `merchantUid`, or `accessToken` in `/api/payments` request
- Request body now contains ONLY `{ amount, note }`
- Server uses authentication context and verified Redis records for merchant identity
- Prevents accidental exposure of sensitive merchant data in transit

**Before:**
```typescript
const response = await fetch(`${config.appUrl}/api/payments`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ 
    amount, 
    note, 
    merchantId,          // ❌ Removed
    merchantUid,         // ❌ Removed
    accessToken          // ❌ Removed
  }),
})
```

**After:**
```typescript
const response = await fetch(`${config.appUrl}/api/payments`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ 
    amount, 
    note
  }),
})
```

## Security Guarantees

### A2U Endpoint (`/api/pi/a2u`)

**Enforced Security Model:**
1. ✅ Accept ONLY `{ paymentId }` in request body - strict validation rejects any extra fields
2. ✅ Require `x-flashpay-internal-secret` header (server-to-server only)
3. ✅ Load merchant data ONLY from verified Redis `payment:${paymentId}` record
4. ✅ Use settlement accounting fields: `payment.merchantId`, `payment.merchantUid`, `payment.amount`, `payment.accessToken`
5. ✅ Never trust merchant data from request body, URL params, or metadata
6. ✅ Fail closed if `A2U_INTERNAL_SECRET` is missing from environment

### A2U_INTERNAL_SECRET Configuration

**Protected from browser exposure:**
- Defined in `/lib/config.ts` without `NEXT_PUBLIC_` prefix → server-only
- Never exported to browser-imported modules
- Used only by `/api/pi/complete` (server-side route handler)
- Validated with timing-safe comparison to prevent timing attacks
- Checked on every request; missing secret causes immediate 500 error

### Client-Side Restrictions

**What clients can no longer send:**
- ❌ `merchantId` - Server derives from authentication context
- ❌ `merchantUid` - Server loads from Redis
- ❌ `accessToken` - Server loads from Redis for A2U verification
- ❌ `action` - Only `/api/pi/a2u` processes payments
- ❌ `a2uPaymentId` - Set by A2U endpoint only
- ❌ `amount` - Loaded from Redis
- ❌ `address` - Loaded from Redis
- ❌ `settlement` fields - Internal only
- ❌ Any other fields - Strict validation rejects them

## Data Flow Diagram

```
Client Payment Creation
├─ POST /api/payments
├─ Body: { amount, note } ← Minimal, no merchant data
└─ Server processes with authenticated merchant context

Settlement (Server-to-Server)
├─ /api/pi/complete
├─ Calls POST /api/pi/a2u
├─ Header: x-flashpay-internal-secret ← Server secret only
├─ Body: { paymentId } ← ONLY paymentId, strict validation
│
└─ /api/pi/a2u
   ├─ Validates request body (EXACTLY 1 key)
   ├─ Loads payment from Redis using paymentId
   ├─ Extracts: payment.merchantId, payment.merchantUid, payment.amount, payment.accessToken
   ├─ Never trusts any merchant data from request
   └─ Performs settlement using ONLY Redis-verified data
```

## Files Modified

1. **`/app/api/pi/a2u/route.ts`**
   - Added `validateA2URequestBody()` function for strict request validation
   - Updated request parsing to use strict validation
   - Enhanced logging showing "Request body validated - contains ONLY paymentId"

2. **`/lib/operations.ts`**
   - Removed `merchantId`, `merchantUid`, `accessToken` from payment creation request body
   - Added comment explaining why merchant data is not sent from client

3. **`/lib/config.ts`** (No changes needed - already correct)
   - `a2uInternalSecret` is server-only (no `NEXT_PUBLIC_` prefix)
   - Never exposed to browser

## Testing Checklist

- [ ] Send request to `/api/pi/a2u` with extra fields → Should reject with 400
- [ ] Send request to `/api/pi/a2u` with empty object → Should reject with 400
- [ ] Send request to `/api/pi/a2u` with only `paymentId` → Should succeed
- [ ] Verify `/api/pi/complete` calls A2U with only `paymentId` in body
- [ ] Verify A2U loads merchant data ONLY from Redis, not request
- [ ] Verify settlement uses `payment.merchantId` from Redis (not request)
- [ ] Verify settlement uses `payment.merchantUid` from Redis (not request)
- [ ] Verify settlement uses `payment.amount` from Redis (not request)
- [ ] Verify settlement uses `payment.accessToken` from Redis (not request)

## Recovery & Troubleshooting

**If A2U_INTERNAL_SECRET is missing:**
- Both `/api/pi/complete` and `/api/pi/a2u` immediately fail with 500
- Check environment variable `A2U_INTERNAL_SECRET` is set
- Must be a non-empty string; no fallback values allowed (fail-closed design)

**If merchant data appears in A2U request logs:**
- Security issue: Client is sending merchant data that should be server-only
- Check `/lib/operations.ts` hasn't re-introduced merchant fields in request
- Verify strict validation is rejecting such requests

**If settlement fails with "Invalid request body":**
- Client is likely sending extra fields to `/api/pi/a2u`
- Check request body validator logs in console
- Ensure ONLY `{ paymentId }` is sent

## References

- A2U Endpoint: `/app/api/pi/a2u/route.ts`
- Complete Route: `/app/api/pi/complete/route.ts`
- Client Operations: `/lib/operations.ts`
- Configuration: `/lib/config.ts`
