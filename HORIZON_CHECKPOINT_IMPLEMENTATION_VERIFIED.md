# Horizon Checkpoint Implementation: Verification Report

## Summary
Implemented precise Horizon checkpoint mechanism that captures exact settlement state after Horizon success, before Pi /complete, with idempotent recovery and fail-closed semantics.

## Implementation Details

### 1. Checkpoint Persistence (After Horizon Success)
**File:** `/app/api/pi/a2u/route.ts` lines 115-161

**Function:** Helper function `persistA2UCheckpoint()` handles:
- Accepts: `{ paymentId, a2uPayment, transaction, submitResult, amount, actualTransferredAmount }`
- Persists to Redis: `payment:${paymentId}`
- Stores exact fields:
  - ✅ `a2uPaymentId` = `a2uPayment.identifier`
  - ✅ `a2uTxid` = `submitResult.hash`
  - ✅ `a2uFromAddress` = `transaction.source`
  - ✅ `a2aToAddress` = `a2uPayment.to_address`
  - ✅ `customerAmount` = verified U2A amount
  - ✅ `merchantAmount` = `actualTransferredAmount`
  - ✅ `horizonFeeCharged` = `submitResult.fee_charged / 10_000_000`
  - ✅ `appCommission` = `0`
  - ✅ `appNetImpact` = calculated
  - ✅ `status` = `"settlement_pending"`
  - ✅ `horizonSuccessFlag` = `true`
  - ✅ `piCompletionPending` = `true`
  - ✅ `piCompleted` = `false` (NEW: Added in this session)

**Error Handling:**
- If persistence fails: Returns 500 with `requiresManualReview: true`
- Returns known `txidFromHorizon` in response
- DOES NOT call Pi /complete
- DOES NOT resubmit to Horizon

### 2. Final Settlement Update (After Pi /complete Success)
**File:** `/app/api/pi/complete/route.ts` lines 404-415

**Update Triggered:** After successful atomic DB transaction recording

**Final State:**
- ✅ `piCompletionPending` = `false` (UPDATED: Settlement finishing)
- ✅ `piCompleted` = `true` (NEW: Settlement fully completed)
- `status` = `"settled_to_merchant"`
- `settledAt` = ISO timestamp

**Persistence:** Redis key `payment:${paymentId}` with updated object

### 3. A2U Request Validation (NEW Security)
**File:** `/app/api/pi/a2u/route.ts` lines 5-42

**Function:** `validateA2URequestBody(body)`
- Accepts ONLY `{ paymentId }`
- Rejects any extraneous fields (merchantId, amounts, addresses, tokens)
- Fails closed: invalid requests get 400 immediately

**Benefit:** Prevents merchant data injection attacks; all authoritative data comes from verified Redis checkpoint

### 4. Client-Side Restriction (NEW Security)
**File:** `/lib/operations.ts` payment creation

**Change:** Removed `merchantId`, `merchantUid`, `accessToken` from request body
- Client now sends ONLY `{ amount, note }` to `/api/payments`
- Server uses authentication context for merchant identity
- Never exposes sensitive data in request

### 5. Recovery Flow
**File:** `/app/api/pi/a2u/route.ts` lines 470-480+ (Recovery section)

**Handles:**
- Payment with `status === "settlement_pending"` and `a2uPaymentId`
- Reattempts Pi /complete using stored A2U identifiers
- **Does NOT:**
  - Resubmit to Horizon (txid already exists)
  - Create new A2U payments (payment already exists)

### 6. Idempotency Guards
**File:** `/app/api/pi/a2u/route.ts` lines 394-400, 462-468

**Early Returns:**
- `settled_to_merchant` status: returns 200 with existing data
- Prevents double-processing
- Allows safe retry without side effects

## Data Flow Integrity

```
payment (pending) 
  → Pi /v2/callback confirms
  → Pi /complete → A2U /v2/payments
  → A2U createPayment succeeds
  → Sign Stellar transaction
  → Horizon submitTransaction succeeds
    ✓ CHECKPOINT PERSISTED (status: settlement_pending, horizonSuccessFlag: true, piCompletionPending: true, piCompleted: false)
    ✗ If checkpoint fails: return manual-review with txid, DON'T call /complete
  → Pi /complete processes checkpoint
  → Atomic DB transaction succeeds
    ✓ FINAL UPDATE (piCompletionPending: false, piCompleted: true, settled_to_merchant)
```

## Critical Guarantees

1. **Horizon submits at most once per payment**
   - Detected via `a2uTxid` field existence
   - Recovery reuses stored txid, never resubmits

2. **No state loss after Horizon success**
   - Checkpoint persisted BEFORE Pi /complete
   - If /complete fails: retry uses stored identifiers and amounts
   - Authoritative amounts frozen in checkpoint

3. **Fail-closed checkpoint persistence**
   - If checkpoint fails after Horizon: return manual-review
   - Never call Pi /complete without checkpoint
   - Known txid available for manual investigation

4. **Exact financial tracking**
   - `customerAmount` = verified U2A reference
   - `merchantAmount` = actual A2U transfer amount
   - `horizonFeeCharged` = actual network fee
   - All reconciled in `appNetImpact`

## Verification Checklist

- [x] A2U request accepts ONLY `{ paymentId }`
- [x] Checkpoint persists all 13 required fields exactly
- [x] `piCompleted: false` set in initial checkpoint
- [x] `piCompleted: true` set after final DB success
- [x] `piCompletionPending: true` → `false` transition
- [x] Checkpoint persistence failures don't call /complete
- [x] Known txids returned on manual-review cases
- [x] Recovery detects `settlement_pending` state correctly
- [x] Client sends ONLY merchant-agnostic fields
- [x] No merchant data in A2U request body

## Next: Manual Review Process

When `requiresManualReview: true` returned:
1. Log includes `txidFromHorizon` or `a2aaTxid`
2. Blockchain state is finalized (Horizon doesn't revert)
3. Manual process checks:
   - Horizon block confirmation
   - Merchant wallet credit
   - Database consistency
4. Retry `/api/pi/complete` with same `paymentId` for DB completion
