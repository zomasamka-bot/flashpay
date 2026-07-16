# PostgreSQL Accounting Fixes - Requirements Verification

## Requirement 1: Store Correct Values
- [x] U2A identifier = Pi U2A identifier → `u2a_identifier` column
- [x] U2A txid = clientTxid → `u2a_txid` column
- [x] A2U identifier = a2uData.a2uPaymentId → `a2u_identifier` column
- [x] A2U txid = a2uData.txid → `a2u_txid` column
- [x] Local UUID kept separate in `transaction_id` column

**Files Modified**:
- `/lib/db.ts` lines 630-648 (receipt insert)
- `/lib/db.ts` lines 563-572 (function params)

---

## Requirement 2: Make Atomic Write Idempotent
- [x] ON CONFLICT (payment_id) DO UPDATE SET completed_at = NOW()
- [x] RETURNING id (fetch existing txId on conflict)
- [x] Never use new invalid UUID
- [x] Logs isNew flag for audit trail

**File Modified**:
- `/lib/db.ts` lines 603-625 (SQL pattern)

---

## Requirement 3: Never Hide DB Failure, Save DB-Failed State
- [x] Never hide DB error
- [x] Never return success before DB commit
- [x] Save `dbReconciliation` state in Redis on failure
- [x] Include u2aTxid, a2uIdentifier, a2uTxid in failed state
- [x] Resume only DB reconciliation on identical retry (not A2U repeat)
- [x] Return 200 to webhook so payment stays PAID

**File Modified**:
- `/app/api/pi/complete/route.ts` lines 422-453

---

## Requirement 4: Read Receipt Token from Unified Store
- [x] Use `merchant.accessToken` from unified store
- [x] Not from sessionStorage/localStorage
- [x] Send Bearer token in receipt API fetch
- [x] `useUnifiedStore()` hook created and exported

**Files Modified**:
- `/app/receipts/[id]/page.tsx` lines 13-30 (import and usage)
- `/lib/unified-store.ts` lines 854-857 (hook export)

---

## Requirement 5: Redis Fallback Scope = Verified Username Only
- [x] `/api/payments/history` uses `verifiedMerchant.username` filter
- [x] `/api/merchant/payments` uses `verifiedMerchant.username` filter
- [x] Never uses URL `merchantId`
- [x] Verified username comes from Bearer token

**Files Verified**:
- `/app/api/payments/history/route.ts` line 148
- `/app/api/merchant/payments/route.ts` line 150

---

## Requirement 6: Do Not Touch U2A/A2U Logic
- [x] U2A payment completion untouched
- [x] U2A Redis state untouched
- [x] A2U API endpoint untouched (only result used for identifiers)
- [x] A2U Horizon submission untouched
- [x] Complete endpoint authorization untouched

**Verified**: Only changes are in `/lib/db.ts` (receipt insert), `/app/api/pi/complete/route.ts` (identifier passing + DB-failed handling), `/app/receipts/[id]/page.tsx` (token source), `/lib/unified-store.ts` (hook export)

---

## Requirement 7: Preserve Diagnostic Logs
- [x] All console.log statements preserved
- [x] New logs only for DB reconciliation state save
- [x] No logs hidden or removed

**Files Verified**:
- `/lib/db.ts` line 625 (transaction logging)
- `/app/api/pi/complete/route.ts` lines 424-453 (DB error logging)

---

## Requirement 8: No Wrong IDs, Hidden Errors, Unsafe Retries
- [x] Identifiers correct (not swapped or wrong)
- [x] DB errors never hidden (all logged)
- [x] Retries don't repeat A2U (only reconcile DB)
- [x] Idempotent on payment_id (safe to retry)

---

## Requirement 9: No Scope, TypeScript, Import, or Syntax Errors
- [x] `useUnifiedStore()` hook properly exported
- [x] `getMerchantState()` method exists in UnifiedStateStore
- [x] `merchant.accessToken` field exists in MerchantState
- [x] All imports valid and working
- [x] No TypeScript compilation errors
- [x] All function signatures match call sites

---

## Requirement 10: Do Not Rely on ignoreBuildErrors
- [x] No ignoreBuildErrors used
- [x] All code properly typed
- [x] All imports resolved
- [x] No eslint-ignore comments added

---

## Final Verification

**Complete Endpoint Flow**:
1. U2A completes, payment marked PAID in Redis ✓
2. Call recordA2UTransactionAtomic with:
   - piPaymentId (A2U identifier) ✓
   - u2aPaymentId (U2A identifier) ✓
   - u2aTxid (clientTxid) ✓
   - a2uTxid (Horizon txid) ✓
3. DB transaction:
   - Insert transaction (idempotent on payment_id) ✓
   - Insert receipt with all 4 identifiers ✓
   - Update merchant balance ✓
4. On DB failure:
   - Save dbReconciliation state in Redis ✓
   - Return 200 to webhook ✓
   - No error thrown ✓
5. Receipt page:
   - Fetch token from unified store ✓
   - Send Bearer token to API ✓
   - API validates merchant ownership ✓

---

✅ **ALL REQUIREMENTS MET**
✅ **READY FOR PRODUCTION**
