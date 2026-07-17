# Horizon Checkpoint: Exact Specification

## Critical Principle
After **every successful Horizon submission** and **before calling Pi /complete**, the settlement checkpoint must be persisted to Redis with exact financial data. If checkpoint persistence fails after Horizon succeeds, the system must return manual-review with the known txid and **MUST NOT** call Pi /complete or resubmit to Horizon.

## Checkpoint Persistence Points

### 1. After Horizon Success (in `/api/pi/a2u`)

**Trigger:** `submitResult = await horizonServer.submitTransaction(transaction)` succeeds

**Checkpoint Fields (EXACT):**
- `a2uPaymentId` - Pi payment identifier from `a2uPayment.identifier`
- `a2uTxid` - Horizon transaction hash from `submitResult.hash`
- `a2uFromAddress` - Blockchain source from `transaction.source`
- `a2aToAddress` - Blockchain destination from `a2uPayment.to_address` (actual A2U destination)
- `customerAmount` - Verified customer U2A amount (authoritative reference)
- `merchantAmount` - Actual A2U operation amount (what was transferred to merchant)
- `horizonFeeCharged` - Actual fee from `submitResult.fee_charged / 10_000_000` (stroops to Pi)
- `appCommission` - Explicit: `0` (no commission in current settlement model)
- `appNetImpact` - Calculated: `customerAmount - merchantAmount - horizonFeeCharged`
- `status` - `"settlement_pending"` (Horizon done, Pi /complete pending)
- `horizonSuccessFlag` - `true` (marks successful Horizon submission)
- `piCompletionPending` - `true` (Pi /complete not yet called)
- `piCompleted` - `false` (settlement not finalized)
- `horizonSuccessAt` - ISO timestamp of checkpoint persistence

**Persistence:** Redis key `payment:${paymentId}` with full payment object including checkpoint fields

**Critical Error Handling:**
```
If checkpoint persistence fails:
  → Return 500 with requiresManualReview: true
  → Return the known txidFromHorizon in response
  → DO NOT call Pi /complete
  → DO NOT resubmit to Horizon
  → Log: "Checkpoint persistence failed after Horizon success"
```

### 2. After Pi /complete Success

**Trigger:** Atomic A2U transaction recorded to database succeeds in `/api/pi/complete`

**Update Fields:**
- `piCompletionPending` - Update to `false`
- `piCompleted` - Update to `true`
- `status` - Update to `"settled_to_merchant"`
- `settledAt` - ISO timestamp of settlement completion

**Persistence:** Redis key `payment:${paymentId}` with updated payment object

## Recovery Flow

### Checkpoint State: `settlement_pending` with Horizon flags

When `/api/pi/complete` encounters a payment with:
- `status === "settlement_pending"`
- `a2uPaymentId` exists
- `a2uTxid` exists

**Recovery Action:** Reattempt Pi /complete using stored A2U identifiers

**Cannot be reused for:**
- Resubmitting to Horizon (Horizon txid already exists)
- Creating new A2U payments (A2U payment already exists)

## Data Flow Guarantee

```
1. Payment created (status: pending)
2. Pi /v2/callback confirms (status: paid_to_app)
3. Pi /complete initiates A2U
4. A2U Horizon submission succeeds
   → CHECKPOINT PERSISTED (status: settlement_pending, horizonSuccessFlag: true, piCompletionPending: true, piCompleted: false)
   → If checkpoint fails: RETURN MANUAL-REVIEW, DON'T CALL Pi /COMPLETE
5. Pi /complete processes checkpoint
6. Atomic DB transaction succeeds
   → FINAL UPDATE (piCompletionPending: false, piCompleted: true, status: settled_to_merchant)
```

## Field Semantics

| Field | Source | Type | Semantics |
|-------|--------|------|-----------|
| a2uPaymentId | `a2uPayment.identifier` | string (Pi identifier) | Authoritative A2U transfer identifier |
| a2uTxid | `submitResult.hash` | string (Stellar txid) | Authoritative blockchain transaction hash |
| a2uFromAddress | `transaction.source` | string (Stellar address) | Source wallet (app wallet) |
| a2uToAddress | `a2uPayment.to_address` | string (Stellar address) | Destination wallet (merchant wallet) |
| customerAmount | checkpoint | number (Pi) | Reference U2A amount that triggered settlement |
| merchantAmount | checkpoint | number (Pi) | Actual amount transferred to merchant |
| horizonFeeCharged | `submitResult.fee_charged / 10000000` | number (Pi) | Network fee charged by Horizon |
| appCommission | checkpoint | number (Pi) | App commission (currently 0) |
| appNetImpact | calculated | number (Pi) | Net cost to app: customerAmount - merchantAmount - horizonFeeCharged |
| horizonSuccessFlag | checkpoint | boolean | Marks successful Horizon submission |
| piCompletionPending | checkpoint | boolean | True when Pi /complete not yet called |
| piCompleted | final | boolean | True when settlement fully completed |

## Idempotency Guarantee

If `/api/pi/complete` is called multiple times with the same `paymentId`:
1. First call: Persists checkpoint after Horizon, calls Pi DB
2. Subsequent calls: Detects settlement_pending state, reuses stored A2U identifiers, completes only DB if needed

**Key:** Never re-Horizon, never create new A2U, always reuse checkpoint identifiers and amounts.

## Manual Review Cases

Return `requiresManualReview: true` ONLY when:
- Checkpoint persistence fails after Horizon success
- Database transaction fails after A2U success
- Recovery retry fails with same A2U identifiers

**Always include:** `txidFromHorizon` or `a2uTxid` in response so manual process can track blockchain state independently.
