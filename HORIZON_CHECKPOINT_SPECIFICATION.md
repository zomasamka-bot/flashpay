# Horizon Checkpoint Specification - EXACT REQUIREMENTS

## Purpose
Every successful `horizonServer.submitTransaction(transaction)` MUST immediately persist a recovery checkpoint before calling Pi /complete. This checkpoint enables exact recovery if persistence fails after Horizon succeeds.

## Checkpoint Persistence - EXACT REQUIREMENTS

**Timing**: Immediately after Horizon returns successfully (submitResult received)
**Medium**: Redis key `payment:${paymentId}` as JSON blob
**Failure Handling**: If checkpoint persistence fails, do NOT call Pi /complete. Return manual-review with known txid.

## Checkpoint Object - EXACT FIELDS & VALUES

```typescript
{
  // === CRITICAL: Original payment object (preserve for recovery routing) ===
  ...payment,  // Spread entire payment object to preserve all original context
  
  // === CRITICAL: Updated status and recovery flags ===
  status: "settlement_pending",           // Explicit state: Horizon succeeded, Pi /complete pending
  horizonSuccessFlag: true,               // BOOLEAN: Horizon submitTransaction succeeded
  piCompletionPending: true,              // BOOLEAN: Pi /complete not yet called
  
  // === CRITICAL: A2U transaction identifiers (from Pi API response) ===
  a2uPaymentId: a2uPayment.identifier,    // STRING: Pi identifier from createPayment response
  a2uTxid: submitResult.hash,             // STRING: Horizon txid from submitTransaction response
  
  // === CRITICAL: A2U blockchain addresses (from A2U, NOT from payment object) ===
  a2uFromAddress: transaction.source,                  // STRING: Stellar source account (app wallet)
  a2uToAddress: a2uPayment.to_address,               // STRING: ACTUAL destination (merchant wallet) - NOT payment.merchantAddress
  
  // === CRITICAL: A2U amount (from A2U payment object, NOT customer amount) ===
  a2uAmount: Number(a2uPayment.amount),              // NUMBER: ACTUAL transferred amount - NOT payment.amount
  
  // === Horizon fee (from submitResult) ===
  horizonFeeCharged: Number(submitResult.fee_charged) / 10_000_000,  // NUMBER: Fee in Pi (stroops ÷ 10M)
  
  // === Timestamps ===
  horizonSuccessAt: new Date().toISOString(),        // ISO string: When Horizon succeeded
}
```

## CRITICAL RULES

1. **ALWAYS use `a2uPayment.to_address` for destination** - NOT `payment.merchantAddress`
   - `a2uPayment.to_address` is the actual Stellar destination from Pi API
   - `payment.merchantAddress` is a Pi identifier, not a Stellar address

2. **ALWAYS use `Number(a2uPayment.amount)` for transferred amount** - NOT `payment.amount`
   - `a2uPayment.amount` is what Pi API will actually transfer
   - `payment.amount` is the original customer amount requested

3. **MUST checkpoint BEFORE calling Pi /complete**
   - Checkpoint failure = stop execution
   - Return manual-review with txidFromHorizon
   - Never resubmit Horizon

4. **Checkpoint idempotency**
   - On retry of A2U endpoint: existing checkpoint enables recovery
   - Pi /complete can be retried safely if checkpoint exists
   - Recovery checks detect settled_to_merchant and return cached success

5. **Status transitions**
   - `paid_to_app` → `settlement_pending` (Horizon success, Pi pending)
   - `settlement_pending` + `horizonSuccessFlag=true` allows Pi /complete retry
   - Only `settled_to_merchant` = final success

## Recovery Paths

### Path 1: settled_to_merchant
- Payment already final
- Return stored success, no Horizon call

### Path 2: settlement_pending + horizonSuccessFlag=true + piCompletionPending=true
- Horizon succeeded, checkpoint persisted
- Pi /complete may have failed or been interrupted
- Retry ONLY Pi /complete, never Horizon
- Use stored a2u identifiers

### Path 3: requiresDbReconciliation + a2uTxid + horizonSuccessFlag=true
- Horizon succeeded, checkpoint persisted, Pi /complete succeeded
- DB persistence failed
- Retry ONLY database reconciliation, never Horizon or Pi

## Never Restart Horizon If

- `a2uTxid` exists (Horizon already succeeded)
- `horizonSuccessFlag=true` (explicit success flag)
- `a2uToAddress` and `a2uAmount` are stored (actual values recorded)

## Horizon Checkpoint Function

**Location**: `horizonSignAndCheckpoint()` in `/app/api/pi/a2u/route.ts`

**Inputs**:
- `horizonServer`, `transaction`: Stellar SDK objects
- `a2uPayment`: Pi API response from createPayment
- `paymentId`, `payment`: Payment context
- `redis`: Redis client
- `baseFee`, `usedFee`: Transaction fee context

**Returns**: `{ success, error?, txidFromHorizon?, horizonFeeCharged?, requiresManualReview? }`

**Logic**:
1. Call `horizonServer.submitTransaction(transaction)`
2. Extract `submitResult.hash` → `txidFromHorizon`
3. Build checkpoint object with actual A2U values
4. Persist to Redis
5. Return success OR manual-review with txid

**Failure Modes**:
- Horizon error → return `{ success: false }`
- Checkpoint error (after Horizon success) → return `{ success: false, txidFromHorizon, requiresManualReview: true }`
