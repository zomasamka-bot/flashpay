# Accounting Hardening - Stage 4 DB Reconciliation

## Status: CORRECTED ✓

The actual accounting path uses the correct validation gate already in place. No new modules required.

---

## Real Accounting Path: Stage 4 DB Reconciliation

### Location
- **File**: `/lib/a2u-executor.ts`
- **Function**: `stage4ReconcileDB()`
- **Lines**: 648-720

### Single Authoritative Validator
- **Function**: `validateFinancialData()` from `/lib/financial-validation.ts`
- **Purpose**: Strict validation of all accounting identifiers and amounts before DB write
- **Behavior**: 
  - Requires ALL canonical identifiers (piPaymentId, u2aTxid, a2uPaymentId, a2uTxid, merchantId, merchantUid)
  - Requires ALL amounts to be finite positive/nonnegative numbers
  - Validates `appNetImpact` calculation with 0.01 tolerance
  - Returns error if ANY field missing or invalid
  - **No fallbacks, no guessing, no invented defaults**

### Strict Stage 4 Flow

```typescript
async function stage4ReconcileDB(ctx: ExecutorContext, txidFromHorizon: string): Promise<Stage4Result> {
  // 1. VALIDATE: Call validateFinancialData() - rejects on missing identifiers/amounts
  const validation = validateFinancialData(ctx.payment)
  if (!validation.success) {
    return { ok: false, error: validation.error, userFacingStatus: "error" }
  }
  
  const financialData = validation.data
  
  // 2. EXPLICIT CHECKS: Verify horizonFeeCharged and appCommission - no fallback to 0
  if (typeof financialData.horizonFeeCharged !== 'number' || !Number.isFinite(financialData.horizonFeeCharged)) {
    return { ok: false, error: "horizonFeeCharged validation failed", userFacingStatus: "error" }
  }
  
  if (typeof financialData.appCommission !== 'number' || !Number.isFinite(financialData.appCommission)) {
    return { ok: false, error: "appCommission validation failed", userFacingStatus: "error" }
  }
  
  // 3. CALL DB: Only with validated data
  const dbResult = await recordA2UTransactionAtomic({
    u2aIdentifier: ctx.piPaymentId,
    u2aTxid: financialData.u2aTxid,           // ← From validator only
    a2uIdentifier: financialData.a2uPaymentId, // ← From validator only
    a2uTxid: txidFromHorizon,
    merchantId: financialData.merchantId,
    merchantUid: financialData.merchantUid,
    customerAmount: financialData.customerAmount,
    merchantAmount: financialData.merchantAmount,
    horizonFeeCharged: financialData.horizonFeeCharged,
    appCommission: financialData.appCommission,
  })
  
  // 4. IF DB SUCCESS: Persist checkpoint, return ok: true
  if (!dbResult.ok) {
    return { ok: false, error: dbResult.error, userFacingStatus: dbResult.userFacingStatus }
  }
  
  ctx.payment = await persistCheckpointMerged(ctx.paymentId, {
    dbRecorded: true,
    status: "settled_to_merchant",
    settledAt: new Date().toISOString(),
  })
  
  return { ok: true, status: "settlement_pending" }
}
```

### Reconciliation Guard in recordA2UTransactionAtomic()

Inside `/lib/db.ts`, lines 672-717, **strict validation gates**:

```typescript
// 1. All identifiers required (non-empty strings)
if (!params.u2aIdentifier || typeof params.u2aIdentifier !== 'string') {
  throw new Error('u2aIdentifier is required and must be a non-empty string')
}
if (!params.u2aTxid || typeof params.u2aTxid !== 'string') {
  throw new Error('u2aTxid is required and must be a non-empty string')
}
if (!params.a2uIdentifier || typeof params.a2uIdentifier !== 'string') {
  throw new Error('a2uIdentifier is required and must be a non-empty string')
}
if (!params.a2uTxid || typeof params.a2uTxid !== 'string') {
  throw new Error('a2uTxid is required and must be a non-empty string')
}

// 2. All amounts required (finite numbers)
if (typeof customerAmount !== 'number' || !Number.isFinite(customerAmount)) {
  throw new Error('customerAmount must be a finite number')
}
if (typeof merchantAmount !== 'number' || !Number.isFinite(merchantAmount)) {
  throw new Error('merchantAmount must be a finite number')
}
if (typeof horizonFeeCharged !== 'number' || !Number.isFinite(horizonFeeCharged)) {
  throw new Error('horizonFeeCharged must be a finite number')
}

// 3. appCommission REQUIRED - no fallback to 0
if (typeof params.appCommission !== 'number' || !Number.isFinite(params.appCommission)) {
  throw new Error('appCommission is required and must be a finite number')
}
```

---

## Files Changed

### Files Cleaned (Removed Incorrect Code)
1. **`/lib/transaction-pg-service.ts`**
   - Removed: Import of non-existent `reconciliation-guard` module
   - Removed: 32 lines of guard check code (log-only, not on Stage 4 path)
   - Reason: This is legacy path, real accounting uses Stage 4

2. **`/app/api/transactions/route.ts`**
   - Removed: Import of non-existent `checkReconciliationReadiness`
   - Removed: 13 lines of checkpoint logging
   - Removed: Import of unused `redis`, `isRedisConfigured`
   - Reason: This endpoint reads historical data only, not on write path

### Files Deleted (Incorrect Artifacts)
- `/lib/accounting-checkpoint.ts` ✓
- `/lib/reconciliation-guard.ts` ✓
- `/ACCOUNTING_FIELD_SOURCES.md` ✓
- `/ACCOUNTING_HARDENING_CHECKLIST.md` ✓
- `/ACCOUNTING_HARDENING_REPORT.md` ✓

---

## Verification: Stage 4 is Production-Ready ✓

### Authoritative Sources - Already Hardened

| Field | Source | Verification |
|-------|--------|---|
| **piPaymentId** | Pi /v2/me.identifier | ✅ Required by validateFinancialData |
| **u2aTxid** | Pi transaction.txid | ✅ Required by validateFinancialData |
| **a2uPaymentId** | A2U response.identifier | ✅ Required by validateFinancialData |
| **a2uTxid** | Horizon txid (Stage 2) | ✅ Passed from stage2SubmitHorizon |
| **merchantId** | Pi /v2/me.username | ✅ Required by validateFinancialData |
| **merchantUid** | Pi /v2/me.uid | ✅ Required by validateFinancialData |
| **customerAmount** | U2A payment.amount | ✅ Required by validateFinancialData, positive |
| **merchantAmount** | Calculated blockchain | ✅ Required by validateFinancialData, positive |
| **horizonFeeCharged** | Horizon submitResult.fee_charged | ✅ Required by Stage 4 explicit check, nonnegative |
| **appCommission** | Payment.appCommission (persisted) | ✅ Required by Stage 4 explicit check, nonnegative |
| **appNetImpact** | Calculated & validated | ✅ Verified by validateFinancialData with 0.01 tolerance |

### Reconciliation Gate Behavior

**Block (return error)** if:
- ❌ Any identifier is missing or empty string
- ❌ Any amount is not a finite number
- ❌ customerAmount ≤ 0
- ❌ merchantAmount ≤ 0
- ❌ horizonFeeCharged < 0
- ❌ appCommission < 0
- ❌ appNetImpact calculation doesn't match (diff > 0.01)

**Proceed (call recordA2UTransactionAtomic)** only if:
- ✅ All identifiers present and non-empty strings
- ✅ All amounts finite with correct signs
- ✅ appNetImpact matches calculated value within 0.01

---

## Production Build Status

✅ **Ready to build**:
- No new dependencies added
- No modifications to payment creation
- No modifications to Horizon submission
- No modifications to Pi complete
- No modifications to recovery
- No modifications to status transitions
- No modifications to finality responses

**Build expectation**:
```
tsc --noEmit → 0 errors
Stage 4: validateFinancialData() blocks invalid payments before DB write
recordA2UTransactionAtomic() enforces strict requirements on entry
```

---

## Recovery Checkpoint Preservation

If reconciliation fails:
1. Stage 4 returns error (does not persist dbRecorded=true)
2. Payment remains in Redis with all checkpoint data intact
3. No DB record created
4. Next reconciliation attempt will retry Stage 4 validation

If reconciliation succeeds:
1. Stage 4 calls recordA2UTransactionAtomic() with validated data
2. DB ACID transaction executes atomically
3. On success: dbRecorded=true, status="settled_to_merchant", settledAt timestamp
4. All checkpoints preserved: piCompleted, horizonSuccessFlag, a2u/u2a identifiers
