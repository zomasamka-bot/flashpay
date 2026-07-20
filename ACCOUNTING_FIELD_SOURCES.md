# Accounting Field Sources - Authoritative Mapping

This document specifies the **single authoritative source** for each accounting field and traces where it's obtained, verified, and persisted.

---

## Transaction Identifiers

### `piPaymentId: string`
- **Authoritative Source**: `finalPiPayment.identifier` from Pi /v2/payments GET
- **Obtained In**: `/api/pi/complete` (Stage 1 U2A verification)
- **Verified By**: Pi API validation (developer_completed, transaction_verified)
- **First Persisted**: `/api/pi/complete` → `payment.piPaymentId = piPaymentIdCanonical`
- **Redis Key**: `payment:${paymentId}` field `piPaymentId`
- **Pre-Reconciliation Check**: `validateAccountingCheckpoint()` ensures present & non-empty
- **DB Schema**: `transactions.payment_id` = `piPaymentId`

### `u2aTxid: string`
- **Authoritative Source**: `finalPiPayment.transaction.txid` from Pi /v2/payments GET (after /complete if needed)
- **Obtained In**: `/api/pi/complete` (Stage 1 U2A verification)
- **Verified By**: Pi API validation (matches client txid, transaction_verified=true)
- **First Persisted**: `/api/pi/complete` → `payment.u2aTxid = finalCanonicalTxid`
- **Redis Key**: `payment:${paymentId}` field `u2aTxid`
- **Pre-Reconciliation Check**: `validateAccountingCheckpoint()` ensures present & non-empty
- **DB Schema**: `receipts.txid` = `u2aTxid`

### `a2uPaymentId: string (Optional until A2U succeeds)`
- **Authoritative Source**: Pi A2U response identifier (obtained from A2U execution)
- **Obtained In**: `/api/pi/a2u` (Stage 2 A2U execution after successful Horizon)
- **Verified By**: Horizon submitTransaction API response
- **Persisted**: `/api/pi/a2u` → `payment.a2uPaymentId = a2uResponse.id`
- **Redis Key**: `payment:${paymentId}` field `a2uPaymentId`
- **Pre-Reconciliation Check**: Optional (only validated if present)
- **DB Schema**: `receipts.a2u_identifier` = `a2uPaymentId`

### `a2uTxid: string (Optional until A2U succeeds)`
- **Authoritative Source**: `transaction.hash` from Horizon submitTransaction response
- **Obtained In**: `/api/pi/a2u` (Stage 2 A2U execution)
- **Verified By**: Horizon API (successful submission)
- **Persisted**: `/api/pi/a2u` → `payment.a2uTxid = horizonTx.hash`
- **Redis Key**: `payment:${paymentId}` field `a2uTxid`
- **Pre-Reconciliation Check**: Optional (only validated if present)
- **DB Schema**: `receipts.a2u_txid` = `a2uTxid`

---

## Party Identifiers

### `merchantId: string`
- **Authoritative Source**: `user.username` from Pi /v2/me GET (authenticated with Bearer token)
- **Obtained In**: `/api/payments` (POST payment creation)
- **Verified By**: Pi authentication (Bearer token validation)
- **Verification Method**: Immediate call to Pi /v2/me with client-provided accessToken
- **First Persisted**: `/api/payments` → `payment.merchantId = trustedMerchantId`
- **Redis Key**: `payment:${paymentId}` field `merchantId`
- **Pre-Reconciliation Check**: `validateAccountingCheckpoint()` ensures present & non-empty
- **DB Schema**: `transactions.merchant_id` = `merchantId`
- **Critical**: Replaces any client-provided merchantId; server-verified username is authoritative

### `merchantUid: string`
- **Authoritative Source**: `user.uid` from Pi /v2/me GET (authenticated with Bearer token)
- **Obtained In**: `/api/payments` (POST payment creation)
- **Verified By**: Pi authentication (same /v2/me call as merchantId)
- **Verification Method**: Extracted from Pi /v2/me response using same accessToken
- **First Persisted**: `/api/payments` → `payment.merchantUid = verifiedMerchantUid`
- **Redis Key**: `payment:${paymentId}` field `merchantUid`
- **Pre-Reconciliation Check**: `validateAccountingCheckpoint()` ensures present & non-empty
- **DB Schema**: NOT directly stored; used for A2U transfer verification at settlement
- **Critical**: This UID is used in A2U transfers; must match Pi identity

### `accessToken: string`
- **Authoritative Source**: Client-provided Bearer token (from Pi.authenticate() on client)
- **Obtained In**: `/api/payments` (POST request headers or body)
- **Verified By**: Immediate Pi /v2/me call using this token
- **Verification Method**: Token successfully authenticates to Pi API
- **First Persisted**: `/api/payments` → `payment.accessToken = accessToken`
- **Redis Key**: `payment:${paymentId}` field `accessToken`
- **Pre-Reconciliation Check**: Not directly validated; presence ensures merchantUid was verified
- **DB Schema**: NOT stored in DB (security best practice); only in Redis for re-verification at A2U
- **Critical**: Used to verify merchantUid is still valid at A2U settlement time

---

## Amount Fields

### `customerAmount: number`
- **Authoritative Source**: `payment.amount` from Pi /v2/payments GET (canonical Pi value)
- **Obtained In**: `/api/pi/complete` (Stage 1 U2A verification)
- **Verified By**: Pi API (must match client txid and blockchain verification)
- **Verification Method**: Validates finite, positive, matches expected amount
- **First Persisted**: `/api/pi/complete` → `payment.customerAmount = finalPiAmount`
- **Redis Key**: `payment:${paymentId}` field `customerAmount`
- **Pre-Reconciliation Check**: `validateAccountingCheckpoint()` ensures:
  - Present in Redis
  - Finite number
  - Positive (> 0)
- **DB Schema**: `receipts.amount` = `customerAmount`
- **Constraint**: Must be ≥ merchantAmount (customer pays at least merchant receives)

### `horizonFeeCharged: number`
- **Authoritative Source**: Horizon submitTransaction response fee data (or fee estimation)
- **Obtained In**: `/api/pi/a2u` (Stage 2 A2U execution)
- **Verified By**: Horizon API response (actual fee charged on successful submission)
- **Verification Method**: Extracted from Horizon response; must be finite non-negative
- **Persisted**: `/api/pi/a2u` → `payment.horizonFeeCharged = horizonFeeValue`
- **Redis Key**: `payment:${paymentId}` field `horizonFeeCharged`
- **Pre-Reconciliation Check**: `validateAccountingCheckpoint()` ensures:
  - Present in Redis
  - Finite number
  - Non-negative (≥ 0)
- **DB Schema**: `receipts.horizon_fee_charged` = `horizonFeeCharged`
- **Constraint**: Deducted from customerAmount; net = customerAmount - horizonFeeCharged - appCommission

### `appCommission: number`
- **Authoritative Source**: App business logic (default 0, configured at payment creation or runtime)
- **Obtained In**: `/api/payments` (POST payment creation) OR `/api/pi/a2u` (during A2U)
- **Verified By**: App configuration (hard-coded or from config.ts)
- **Verification Method**: Validated to be finite non-negative
- **Persisted**: At creation → `payment.appCommission = 0` (or configured value)
- **Redis Key**: `payment:${paymentId}` field `appCommission`
- **Pre-Reconciliation Check**: `validateAccountingCheckpoint()` ensures:
  - Present in Redis (default 0 if not set)
  - Finite number
  - Non-negative (≥ 0)
- **DB Schema**: `receipts.app_commission` = `appCommission`
- **Constraint**: Deducted from customerAmount; part of appNetImpact

### `merchantAmount: number`
- **Authoritative Source**: CALCULATED from: `customerAmount - horizonFeeCharged - appCommission`
- **Calculated In**: `/api/pi/a2u` (after horizonFeeCharged is known) OR pre-calculated if fees estimated
- **Persisted**: `/api/pi/a2u` → `payment.merchantAmount = calculatedValue`
- **Redis Key**: `payment:${paymentId}` field `merchantAmount`
- **Pre-Reconciliation Check**: `validateAccountingCheckpoint()` ensures:
  - Present in Redis
  - Finite number
  - Positive (> 0) - merchant must receive something
  - Matches calculation: `abs(stored - calculated) ≤ 0.01` (tolerance for float rounding)
- **DB Schema**: `receipts.amount` OR derived in view
- **Constraint**: This is the amount actually transferred to merchant via A2U

### `appNetImpact: number`
- **Authoritative Source**: CALCULATED from: `horizonFeeCharged + appCommission`
- **Calculated In**: `/api/pi/a2u` (after both horizonFeeCharged and appCommission known)
- **Persisted**: `/api/pi/a2u` → `payment.appNetImpact = horizonFeeCharged + appCommission`
- **Redis Key**: `payment:${paymentId}` field `appNetImpact`
- **Pre-Reconciliation Check**: `validateAccountingCheckpoint()` ensures:
  - Present in Redis
  - Finite number
  - Can be negative (if app subsidizes fees)
  - Matches calculation: `abs(stored - calculated) ≤ 0.01` (tolerance for float rounding)
- **DB Schema**: `receipts.app_net_impact` (may be negative)
- **Constraint**: What app keeps/absorbs; negative means app pays out

---

## Persistence Timeline

```
1. Payment Creation (/api/payments)
   ✓ merchantId (from Pi /v2/me.username)
   ✓ merchantUid (from Pi /v2/me.uid)
   ✓ accessToken (client-provided, verified via /v2/me)
   ✓ amount (from client request, becomes customerAmount later)
   ✓ appCommission (default 0)

2. U2A Completion (/api/pi/complete)
   ✓ customerAmount (from Pi payment.amount, canonical)
   ✓ u2aTxid (from Pi transaction.txid, canonical)
   ✓ piPaymentId (from Pi payment.identifier, canonical)
   ✓ paidAt (timestamp)
   ✓ status → "paid_to_app"

3. A2U Execution (/api/pi/a2u)
   ✓ horizonFeeCharged (from Horizon submitTransaction response)
   ✓ a2uPaymentId (from Pi A2U response, if applicable)
   ✓ a2uTxid (from Horizon transaction.hash)
   ✓ merchantAmount (calculated: customerAmount - horizonFeeCharged - appCommission)
   ✓ appNetImpact (calculated: horizonFeeCharged + appCommission)
   ✓ status → "settlement_pending" → "settled_to_merchant"

4. DB Reconciliation (recordTransactionToPG)
   ✓ validateAccountingCheckpoint() confirms ALL fields present & valid
   ✓ checkReconciliationGuard() confirms payment ready for DB
   → INSERT INTO transactions, receipts, merchant_balances
   → Set dbRecorded = true
```

---

## Reconciliation Guards

Before ANY database write, `recordTransactionToPG()` calls `checkReconciliationGuard(payment)` which validates:

### Gate 1: Accounting Checkpoint Valid
- ✓ All transaction identifiers present (piPaymentId, u2aTxid)
- ✓ All party identifiers present (merchantId, merchantUid)
- ✓ All amounts finite and correctly signed
- ✓ Calculated amounts match (merchantAmount, appNetImpact)

### Gate 2: Payment Status Compatible
- ✓ Status in [paid_to_app, settlement_pending, settled_to_merchant]
- ✗ Cannot reconcile pending (no U2A yet) or failed/cancelled

### Gate 3: No Double Reconciliation
- ✓ dbRecorded ≠ true
- ✗ Cannot re-reconcile already-recorded payments

### Gate 4: Recovery State Preserved
- ✓ horizonSuccessFlag ↔ a2uTxid consistency
- ✗ Cannot reconcile with corrupted recovery flags

---

## Sources of Truth

| What | Primary Source | Verification Method | Authoritative When |
|---|---|---|---|
| merchantId | Pi /v2/me.username | Bearer token auth | Payment created |
| merchantUid | Pi /v2/me.uid | Bearer token auth | Payment created |
| customerAmount | Pi payment.amount | Pi API response | U2A completed |
| u2aTxid | Pi transaction.txid | Pi API response | U2A completed |
| piPaymentId | Pi payment.identifier | Pi API response | U2A completed |
| horizonFeeCharged | Horizon response | Horizon submitTransaction success | A2U executed |
| appCommission | App config | Hard-coded / runtime config | Payment created |
| merchantAmount | Calculation | Validated against derivation | Post-A2U |
| appNetImpact | Calculation | Validated against derivation | Post-A2U |

---

## No Fallbacks

The reconciliation guard enforces:
- ✗ NO guessing merchantId from anywhere other than Pi /v2/me.username
- ✗ NO using client-provided merchantId
- ✗ NO defaulting missing identifiers
- ✗ NO recalculating identifiers from past states
- ✗ NO skipping verification steps
- ✗ NO proceeding with incomplete data

If ANY field is missing, invalid, or inconsistent → **BLOCK reconciliation** → Log issues → Preserve checkpoint for manual review.
