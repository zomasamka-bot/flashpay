# `/app/api/pi/complete/route.ts` - U2A Authoritative Completion Handler

## Exact Changes Made

### 1. **Added Pi /complete endpoint call (Lines 113-175)**
   - **NEW**: If `developer_completed !== true`, calls `POST /v2/payments/{piPaymentId}/complete` with txid
   - **NEW**: Refetches payment after /complete call
   - **NEW**: Re-validates identifier, direction, amount, txid, non-cancelled, and `developer_completed=true` on refetched payment
   - **If already developer_completed**: Skips Pi /complete call

### 2. **Removed customerAmount fallback (Line 219)**
   - **REMOVED**: `const customerAmount = payment.customerAmount || payment.amount`
   - **REPLACED**: `const customerAmount = payment.customerAmount`
   - **EFFECT**: Now requires customerAmount to be present; never uses payment.amount as fallback

### 3. **Moved merchantUid validation earlier (Lines 200-205)**
   - **REORDERED**: merchantUid validation now happens BEFORE calling executeA2U (line 201 → validated before line 241)
   - **COMMENT**: Added explicit "Validate merchantUid BEFORE any A2U execution" note

### 4. **Never overwrites newer settlement fields (Line 230)**
   - **COMMENT**: Added explicit "Only persist U2A completion fields; never overwrite settlement_pending or settled_to_merchant"
   - **BEHAVIOR**: Persists only `status=paid_to_app`, `u2aTxid`, `paidAt`; never downgrades from settled_to_merchant

### 5. **Invokes executor exactly once (Lines 238-256)**
   - **FLOW**: Executor called once at STAGE 4, returns to client
   - **COMMENT**: "Call unified executor once to handle all A2U settlement stages"

### 6. **Re-reads canonical state and returns once (Lines 258-275)**
   - **FLOW**: STAGE 5: re-reads from Redis
   - **FLOW**: STAGE 6: returns canonical response built from latest state
   - **COMMENT**: Explicit "invoked once" note in header

## Removed Downgrade and Fallback Paths

| Removed Path | Location | Type |
|---|---|---|
| `\|\| payment.amount` fallback for customerAmount | Original Line 88 | **Fallback removed** |
| Implicit downgrade via missing merchantUid validation | Before executor | **Guard added** |
| Implicit downgrade via missing developer_completed check | Original flow | **Check added** |

## Preserved Behavior

✅ Never returns early on a2uTxid  
✅ Executor handles resumption  
✅ Never overwrites stale state over newer checkpoint  
✅ Delegation to lib/a2u-executor.ts for settlement/financial/DB logic  
✅ All headers and imports unchanged  
✅ No redesign of locking or guard stacking  

## Build Status

**File Modified**: `/app/api/pi/complete/route.ts`  
**Lines Changed**: +67 (Pi /complete call logic), -3 (removed fallback), Reordered validation  
**Total Lines**: ~290  
**Syntax**: Valid TypeScript  
**Imports**: Unchanged (NextRequest, NextResponse, redis, serverConfig, buildA2USuccessResponse, executeA2U, Payment)
