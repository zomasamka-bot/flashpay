# FlashPay Production Build Verification

## ⚠️ CRITICAL ISSUES - NOT PRODUCTION READY

### Issue 1: A2U Recovery NOT Idempotent ❌
**Problem**: A2U never reuses stored identifiers on retry
- `settlement_pending` state saved but `/api/pi/a2u` always submits NEW transfer
- No check for existing `a2uPaymentId` before calling Horizon
- **Risk**: Duplicate A2U transfers if retry occurs after Horizon succeeds

**Root Cause**: `/api/pi/a2u` missing logic to detect stored recovery state
**Fix Required**: Check for `a2uPaymentId` in Redis before submitting, skip Horizon if already exists

### Issue 2: Merchant Accounting WRONG ❌
**Problem**: Merchant credited with full customer amount instead of net
- Line 744 in `/lib/db.ts`: `VALUES (${params.amount}, ...` — wrong!
- Should credit merchant with `${merchantAmount}` after fees deducted
- **Loss**: App losing settlement fees to merchant overpayment

**Root Cause**: Wrong field passed to merchant balance update
**Fix Required**: Use `merchantAmount` (amount - horizonFee - appCommission) for merchant credit

### Issue 3: A2U Persistence Too Late ❌
**Problem**: Identifiers saved AFTER DB commit in `/api/pi/complete`
- If DB succeeds but Redis fails, loss of recovery data
- No atomic guarantee between A2U success and Redis persistence
- **Risk**: Unrecoverable duplicate transfers

**Root Cause**: Redis update at end of `/api/pi/complete` after DB transaction
**Fix Required**: Save A2U identifiers to Redis IMMEDIATELY after Horizon succeeds, BEFORE DB call

### Issue 4: False Claims in Verification Document ❌
**Problem**: This file claims fixes are applied but code is broken
- Idempotent recovery section marked ✅ but not implemented
- Atomic failure recovery section marked ✅ but timing is wrong
- Database accounting marked ✅ but calculation uses wrong field

**Root Cause**: Document written before implementation completed
**Fix Required**: Remove all false ✅ checkmarks, document actual state

## Actual Implementation Status

### A2U Flow (BROKEN)
1. ❌ Horizon submits transfer → returns txid + fee
2. ❌ identifiers NOT saved to Redis yet
3. ✅ DB transaction begins
4. ❌ If DB succeeds → Redis save (too late)
5. ❌ If DB fails after Horizon succeeded → NO recovery state in Redis
6. ❌ Retry never reuses A2U, always submits new transfer

### Merchant Accounting (WRONG)
- **Actual**: merchant_amount NOT used when crediting balance
- **Expected**: merchant_amount = customer_amount - horizonFee - appCommission
- **Impact**: All merchant balances inflated by full fee amounts

### Required Fixes (Before Any Production Push)

1. **Save A2U identifiers BEFORE DB call**
   - After Horizon succeeds, atomically save to Redis:
     - `a2uPaymentId`
     - `a2uTxid`
     - `horizonFeeCharged`
     - `a2uFromAddress`, `a2uToAddress`
   - Only then proceed to DB

2. **Implement idempotent recovery in A2U endpoint**
   - Check for existing `a2uPaymentId` in payment record
   - If exists → skip Horizon, go straight to status check
   - Never submit second A2U transfer

3. **Fix merchant balance credit**
   - Change `/lib/db.ts` line 744 from `${params.amount}` to `${merchantAmount}`
   - Verify appNetImpact is calculated correctly
   - Test merchant receives correct net amount

4. **Build and Deploy**
   - Run `pnpm run build` until zero TypeScript errors
   - Deploy to Vercel
   - Verify commit passes all checks
   - Only then mark complete

## DO NOT DEPLOY UNTIL ALL FIXED
