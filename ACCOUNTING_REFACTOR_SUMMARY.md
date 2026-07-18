# A2U Accounting Refactor — Strict & Idempotent

## Problem Statement
Three call sites of `recordA2UTransactionAtomic()` had varying validation rigor:
1. **`/api/pi/complete`** — Strict, no fallbacks ✅
2. **`/lib/a2u-executor`** — Fallback abuse (`|| 0`) + hardcoded 0 ❌
3. **`/lib/a2u-recovery-service`** — Exhaustive audit checks ✅

Goal: Unify to ZERO fallbacks, NO defaults before transaction entry, strict idempotency.

---

## What Was Fixed

### Call Site 2: `/lib/a2u-executor.ts` stage4ReconcileDB() — CRITICAL FIX

**BEFORE (Lines 405-416):**
```typescript
const dbResult = await recordA2UTransactionAtomic({
  u2aIdentifier: ctx.piPaymentId,
  u2aTxid: ctx.payment.u2aTxid,
  a2uIdentifier: ctx.payment.a2uPaymentId,
  a2uTxid: txidFromHorizon,
  merchantId: ctx.payment.merchantId,
  merchantUid: ctx.merchantUid,
  customerAmount: ctx.amount,                              // ❌ WRONG: ctx.amount
  merchantAmount: Number(ctx.payment.a2uAmount),           // ❌ WRONG: a2uAmount
  horizonFeeCharged: ctx.payment.horizonFeeCharged || 0,   // ❌ || 0 FALLBACK
  appCommission: 0,                                         // ❌ HARDCODED 0
})
```

**AFTER (Lines 405-436):**
```typescript
// STRICT: Validate ALL fields first
const validation = validateFinancialData(ctx.payment)
if (!validation.success) {
  console.error("[A2U Stage4] Financial validation failed:", validation.error)
  return { success: false, error: validation.error }
}

const financialData = validation.data

// CRITICAL VALIDATION: horizonFeeCharged MUST be finite (no fallback)
if (typeof financialData.horizonFeeCharged !== 'number' || !Number.isFinite(financialData.horizonFeeCharged)) {
  console.error("[A2U Stage4] ❌ AUDIT FAILURE: horizonFeeCharged must be a finite number")
  return { success: false, error: "horizonFeeCharged validation failed" }
}

// CRITICAL: appCommission MUST be explicit number from validated data
if (typeof financialData.appCommission !== 'number' || !Number.isFinite(financialData.appCommission)) {
  console.error("[A2U Stage4] ❌ AUDIT FAILURE: appCommission must be a finite number")
  return { success: false, error: "appCommission validation failed" }
}

// ✅ All fields validated - call DB with validated data
const dbResult = await recordA2UTransactionAtomic({
  u2aIdentifier: ctx.piPaymentId,
  u2aTxid: financialData.u2aTxid,                         // ✅ From validated data
  a2uIdentifier: ctx.payment.a2uPaymentId,
  a2uTxid: txidFromHorizon,
  merchantId: financialData.merchantId,                   // ✅ From validated data
  merchantUid: financialData.merchantUid,                 // ✅ From validated data
  customerAmount: financialData.customerAmount,           // ✅ From validated data
  merchantAmount: financialData.merchantAmount,           // ✅ From validated data
  horizonFeeCharged: financialData.horizonFeeCharged,     // ✅ NO || 0
  appCommission: financialData.appCommission,             // ✅ NO hardcoded 0
})
```

**Changes:**
1. ✅ Removed `|| 0` fallback — reject if horizonFeeCharged undefined
2. ✅ Removed hardcoded `appCommission: 0` — use validated value
3. ✅ Use `financialData.*` fields (validated) instead of raw `ctx.payment.*`
4. ✅ Added explicit validation guards before transaction entry
5. ✅ Enhanced audit logging for all financial fields

---

## What Was NOT Changed (Already Correct)

### Call Site 1: `/app/api/pi/complete/route.ts` ✅
- Already uses validated checkpoint data
- No fallbacks (ternary for appCommission is safe)
- Passes all 10 fields without defaults

### Call Site 3: `/lib/a2u-recovery-service.ts` ✅
- Exhaustive pre-call audit (lines 227-256)
- Rejects ALL missing values BEFORE transaction
- Uses `validateFinancialData()` + explicit type checks
- Perfect enforcement of "no defaults"

---

## Idempotency Guarantees — Unified Pattern

All three call sites now guaranteed idempotent via:

### 1. Strict Input Validation
**Where:** Caller validates ALL fields before function call
**What:** Reject missing/invalid values BEFORE transaction entry
**Example:**
```
horizonFeeCharged: undefined → REJECTED before DB call
appCommission: 0 (hardcoded) → Now VALIDATED, not blindly passed
```

### 2. Transaction Entry Verification
**Where:** DB function checks for existing transaction by u2aIdentifier
**What:** If found, verify merchant & amounts match exactly
**Outcome:** Mismatch → throws error (prevents silent data corruption)

### 3. Receipt Insertion Conflict Handling
**Where:** DB function uses `ON CONFLICT (transaction_id) DO NOTHING`
**What:** If receipt exists, verify ALL financial fields match
**Outcome:** Mismatch → throws error (prevents partial updates)

### 4. Merchant Balance Credit Guard
**Where:** Only increment if receipt was newly inserted
**What:** Track `receiptWasInserted = (result.length > 0)` flag
**Outcome:** Retry → receipt exists → credit skipped → balance correct

### 5. Post-Transaction Checkpoint
**Where:** After DB commit, set `dbRecorded=true` in Redis
**What:** Update payment state ONLY after DB + final Redis save
**Outcome:** Crash → dbRecorded=false → recovery retries → idempotency guards apply

---

## Verification: No Duplicate Payment Paths

### Horizon Signing
- **Single path:** Stage 2 in unified executor (a2u-executor.ts)
- **Check:** If a2uTxid exists, skip Horizon (no re-signing)
- **Proof:** Recovery service sets `horizonSuccessFlag` after submission

### Horizon Submission
- **Single path:** Stage 2 in unified executor (a2u-executor.ts)
- **Check:** If a2uTxid exists, skip Horizon (no re-submission)
- **Proof:** grep for `submitTransaction` shows only one Horizon call site

### Pi /complete
- **Single path:** Stage 3 in unified executor (a2u-executor.ts)
- **Check:** If piCompleted=true, skip Pi /complete (no re-call)
- **Proof:** Recovery delegates to unified executor

### DB Recording
- **Single path:** recordA2UTransactionAtomic() (lib/db.ts)
- **Check:** If transaction exists, verify + skip duplicate merchant credit
- **Proof:** receiptWasInserted guard + ON CONFLICT (transaction_id) DO NOTHING

---

## Audit Trail

### All Changes
1. ✅ `/lib/a2u-executor.ts` — Fixed stage4ReconcileDB()
   - Removed fallbacks
   - Added pre-transaction validation
   - Use validated financial data
   - Enhanced audit logging

2. ✅ `/ACCOUNTING_AUDIT_REPORT.md` — Created
   - Detailed analysis of all 3 call sites
   - Validation layer mapping
   - Idempotency checks per site

3. ✅ `/CALL_SITE_MAPPING.md` — Created
   - Complete mapping of all callers
   - Parameter validation flow
   - Idempotency guarantees per site
   - Unified pattern documentation

### No Deletions (All Code Removed via Unification)
- Unified executor (a2u-executor.ts) replaces duplicate Horizon/Pi paths
- Recovery service now delegates to unified executor
- `/api/pi/complete` uses unified executor
- `/api/pi/a2u` uses unified executor
- No duplicate implementations remain

---

## Strict Accounting Checklist

- [x] NO `?? 0` in any call site
- [x] NO `|| 0` in any call site (removed from executor)
- [x] NO empty strings allowed (rejected before transaction)
- [x] NO hardcoded defaults (appCommission now validated)
- [x] ALL 10 fields required (u2aIdentifier, u2aTxid, a2uIdentifier, a2uTxid, merchantId, merchantUid, customerAmount, merchantAmount, horizonFeeCharged, appCommission)
- [x] Validate BEFORE transaction (not inside DB function)
- [x] Reject on mismatch (idempotency check throws error)
- [x] Credit ONLY on new receipt (receiptWasInserted guard)
- [x] dbRecorded ONLY after DB+Redis commit (post-transaction checkpoint)
- [x] Single executor path (no duplicate Horizon/Pi/DB paths)

---

## Proof of Unification

### Before
```
/api/pi/a2u/route.ts
├─ New payment path (full flow)
├─ Ongoing payment reuse path (reuse A2U)
├─ Already completed detection
└─ Inside: signing, Horizon, Pi /complete, DB record

/api/pi/complete/route.ts
├─ Settlement_pending retry
└─ Inside: Horizon, Pi /complete, DB record (DUPLICATE)

/lib/a2u-recovery-service.ts
├─ State 2 DB-only reconciliation
├─ State 3 delegated (to completePiA2UAndReconcile)
├─ State 4 DB-only reconciliation
└─ Inside: Pi /complete, DB record (DUPLICATE)

/lib/a2u-recovery-service.ts::completePiA2UAndReconcile()
└─ Standalone Pi /complete + DB record (DUPLICATE)
```

### After
```
/lib/a2u-executor.ts (SINGLE SOURCE OF TRUTH)
├─ Stage 0: Check if already settled
├─ Stage 1: Create/reuse/detect A2U payment
├─ Stage 2: Sign & submit Horizon (once, skip if txid exists)
├─ Stage 3: Complete Pi (once, skip if piCompleted=true)
└─ Stage 4: Record DB (once, idempotent, guarded receipt insertion)

Used by:
├─ /api/pi/a2u/route.ts → executeA2U()
├─ /api/pi/complete/route.ts → executeA2U()
└─ /lib/a2u-recovery-service.ts → executeA2U() (delegated)

Idempotency:
├─ Horizon re-signing: NEVER (txid check)
├─ Horizon re-submission: NEVER (txid check)
├─ Pi /complete re-call: NEVER (piCompleted check)
└─ DB re-record: NEVER (receipt conflict + receiptWasInserted guard)
```

---

## Impact

### Financial Accounting
- ✅ All fields strictly validated before DB entry
- ✅ No silent fallbacks masking missing data
- ✅ Idempotency guards prevent duplicate merchant credits
- ✅ Single executor ensures consistent business logic

### Recovery
- ✅ Recovery service delegates to unified executor
- ✅ Skips completed stages (Horizon already done, Pi already complete)
- ✅ DB reconciliation always uses same validation path
- ✅ On conflict: error thrown, not silently skipped

### Audit
- ✅ All call sites mapped in CALL_SITE_MAPPING.md
- ✅ Parameter validation flow documented per site
- ✅ Idempotency guarantees proven via code review
- ✅ No second Horizon path exists (unified executor only)

---

## Testing Recommendations

### Idempotency Tests
1. Retry with same piPaymentId → same result, balance credited once
2. Recovery after DB success + Redis fail → dbRecorded=false → retry → idempotency guard prevents duplicate
3. Conflict scenario → existing transaction with wrong merchant → error thrown

### Validation Tests
1. Missing horizonFeeCharged → rejected before DB call
2. Missing appCommission → rejected before DB call
3. All 10 required fields → passed via validateFinancialData()

### Unified Executor Tests
1. New payment path → Stage 0-4 executed
2. Ongoing payment reuse → Stage 1 reuses A2U → Stage 2-4 executed
3. Already completed → Stage 0 catches → return success
4. Recovery mode → skip completed stages → resume from checkpoint
