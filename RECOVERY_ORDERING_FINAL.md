# Precise Recovery Ordering - Final Implementation

**Last Updated**: 7/17/2026
**Status**: IMPLEMENTED IN lib/operations.ts::handlePaymentRecovery()

## Core Principle

Recovery must check states in **exact order**. Final success requires:
1. **Horizon**: Funds moved to merchant wallet on Stellar
2. **Pi /complete**: Notified Pi Network of settlement
3. **Atomic DB accounting**: User balance reduced, merchant balance increased

DO NOT mark `settled_to_merchant` merely because stored IDs were returned.

---

## Recovery Order (EXACT SEQUENCE)

### 1️⃣ settled_to_merchant
**Action**: Return stored success with NO Pi, Horizon, or DB balance action
- Status already final
- Call outer `onSuccess(txid)` exactly once
- NO state changes, NO API calls
- Idempotent - safe to retry

### 2️⃣ requiresDbReconciliation + a2uTxid + horizonSuccessFlag
**Action**: Run `recordA2UTransactionAtomic` directly from lib/db.ts
- Use stored trusted values (u2aTxid, a2uTxid, identifiers)
- NO A2U call, NO Horizon call
- Atomic DB transaction: user debit + merchant credit + receipt
- Mark as `settled_to_merchant` after DB succeeds
- Call `onSuccess(a2uTxid)`

### 3️⃣ settlement_pending + piCompletionPending=true + stored A2U IDs
**Action**: Retry ONLY Pi `/complete` with same identifier and txid
- NO A2U retry, NO Horizon retry
- Use stored identifiers exactly as cached
- If `/complete` returns `settled_to_merchant`, mark as settled
- Call `onSuccess(txid)`

### 4️⃣ Pi completed but DB pending
**Conditions**: `horizonSuccessFlag === true` + `a2uTxid` + NOT `requiresDbReconciliation`
**Action**: Perform DB-only reconciliation
- Horizon and Pi already succeeded
- Only DB accounting remains
- Call `recordA2UTransactionAtomic` with stored values
- Mark as `settled_to_merchant`
- Call `onSuccess(a2uTxid)`

### 5️⃣ settlement_failed
**Action**: NEVER restart if `a2uTxid` or `horizonSuccessFlag` exists
- If either identifier exists: IRREVERSIBLE failure
  - A2U failed after Horizon succeeded → funds stuck
  - Or Pi rejected settlement → backend cannot recover
  - Return error: "Irreversible failure - contact support"
- If no identifiers: Retry eligible
  - Pre-settlement failure
  - Safe to try payment again

---

## State Semantics

### Processing States (NOT errors, not terminal)
- `paid_to_app`: U2A confirmed, awaiting backend A2U
- `settlement_pending`: A2U called, awaiting Horizon or Pi /complete

### Terminal States
- `settled_to_merchant`: FINAL, funds on merchant wallet + Pi notified
- `failed`: Pre-settlement failure, safe to retry
- `settlement_failed`: Post-Horizon failure, check identifiers before retrying
- `cancelled`: User cancelled in Pi Wallet
- `cancelled`: User cancelled in Pi Wallet

### Recovery Flags
- `horizonSuccessFlag`: Horizon submitTransaction succeeded
- `piCompletionPending`: Horizon succeeded but Pi /complete not yet called
- `requiresDbReconciliation`: A2U and Horizon succeeded, DB accounting pending

---

## Implementation (lib/operations.ts)

```typescript
export async function handlePaymentRecovery(
  payment: Payment,
  onSuccess: (txid: string) => void,
  onError: (error: string, trackingId?: string) => void,
): Promise<void>
```

Called from:
- **Customer polling** (components/customer-payment-view.tsx)
- **Manual recovery** (app/emergency/page.tsx)

Recovery runs BEFORE normal polling if recovery state detected.

---

## Key Rules

1. **No Downgrade**: Never set status to earlier state than current
2. **Stored Values**: Use cached identifiers, never re-call A2U or Horizon
3. **Atomic DB**: recordA2UTransactionAtomic is all-or-nothing
4. **Final Success**: Only when settled_to_merchant confirmed
5. **No Mark-and-Hope**: Don't set status based on assumptions

---

## Polling Flow (components/customer-payment-view.tsx)

```
Every 2 seconds while !isPaymentPaid && !isPaying:
  If recovery state detected:
    → Call handlePaymentRecovery()
    → If success: call onSuccess, stop polling
    → If error: continue polling normally
  Else:
    → Normal fetch + server check
```

---

## Testing Checklist

- [ ] settled_to_merchant: Returns success immediately
- [ ] DB reconciliation: Debit + credit atomic, no partial states
- [ ] Pi /complete retry: Uses stored identifiers exactly
- [ ] Pi completed + DB pending: DB reconciliation only
- [ ] settlement_failed + identifiers: Refuses to retry
- [ ] settlement_failed + no identifiers: Allows retry
- [ ] No downgrade from settled_to_merchant
- [ ] onSuccess called exactly once per recovery path
