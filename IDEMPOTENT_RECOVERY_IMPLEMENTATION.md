# Idempotent Recovery & Accounting - Status: INCOMPLETE

**Critical Notice**: This document describes intended fixes that are NOT YET VERIFIED as working.

## Issues Requiring Fix

### 1. Merchant Accounting - UNVERIFIED
- Parameter names changed from `amount` to `customerAmount` and `merchantAmount`
- Receipt INSERT updated to use `merchantAmount` instead of `params.amount`
- **ISSUE**: Caller in `/app/api/pi/complete/route.ts` may not be passing correct values
- **REQUIRED**: Verify `a2uData.customerAmount` and `a2uData.merchantAmount` exist in response

### 2. A2U Persistence Timing - UNVERIFIED
- Recovery state added to `/app/api/pi/a2u/route.ts` after Horizon success
- **ISSUE**: Persistence occurs AFTER Horizon submit but BEFORE DB call in `/api/pi/complete`
- **REQUIRED**: Move persistence to `/api/pi/a2u` BEFORE calling `/api/pi/complete`, not after

### 3. Idempotent A2U Recovery - UNREACHABLE
- Check for stored `a2uPaymentId` added to `/app/api/pi/a2u/route.ts`
- **ISSUE**: This code is only reached if `/api/pi/a2u` is called again, but retry flow does not call it
- **REQUIRED**: Implement actual retry logic in `/api/pi/complete` that calls `/api/pi/a2u` with stored payment

### 4. Horizon Fee Calculation - UNVERIFIED
- Code references `submitResult.fee_charged / 10_000_000`
- **ISSUE**: No verification that `submitResult.fee_charged` actually contains stroops value
- **REQUIRED**: Verify Horizon response structure and add explicit type checking

### 5. DB Reconciliation - MISSING
- No fallback if Horizon succeeds but database insert fails
- **REQUIRED**: Add reconciliation query to detect settled payments not in database

## Required Verification

Do NOT claim completion until:

- [ ] `pnpm run build` passes with zero TypeScript errors
- [ ] SDK request/response formats verified compatible
- [ ] Horizon fee captured from actual `submitResult.fee_charged`
- [ ] Recovery data persisted BEFORE DB attempt, not after
- [ ] Retry flow actually calls A2U with recovery check
- [ ] Database accounting verified against blockchain amounts
- [ ] End-to-end test confirms idempotent recovery works
- [ ] Double-click test confirms no duplicate A2U transfers

## Files Modified (Unverified)

1. `/lib/db.ts` - Parameter names changed
2. `/app/api/pi/a2u/route.ts` - Recovery persistence added (timing unclear)
3. `/app/api/pi/complete/route.ts` - Call updated with new parameters

## DO NOT DEPLOY

Application fails to build. All claimed fixes are incomplete and unverified.
