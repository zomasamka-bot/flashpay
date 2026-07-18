# STATUS ALIGNMENT AUDIT & FINAL DECISION TABLE

## AUTHORITATIVE STATUS ENUM (7 values only)

```typescript
type PaymentStatus = "pending" | "failed" | "cancelled" | "paid_to_app" | 
                     "settlement_pending" | "settled_to_merchant" | "settlement_failed"
```

## FINAL STATUS/RETRY DECISION TABLE

| Status | Type | Client Retry? | Server Poll? | Start U2A? | Comments |
|--------|------|---------------|--------------|-----------|----------|
| **pending** | Fresh | ❌ No (processing) | ✅ (short) | ✅ Yes | Initial, awaiting Pi Wallet |
| **failed** | Error | ✅ Yes | ❌ No | ✅ Yes (new) | Pre-U2A failure, retryable |
| **cancelled** | Cancel | ✅ Yes | ❌ No | ✅ Yes (new) | Customer cancelled, retryable |
| **paid_to_app** | Processing | ❌ No (blocked) | ✅ (long) | ❌ No | U2A done, settling A2U, poll only |
| **settlement_pending** | Processing | ❌ No (blocked) | ✅ (long) | ❌ No | A2U in progress, poll only |
| **settled_to_merchant** | Success | ❌ No (final) | ❌ No | ❌ No | **ONLY final success state** |
| **settlement_failed** (no flags) | Error | ✅ Yes | ❌ No | ✅ Yes (new) | A2U failed pre-Horizon, retryable |
| **settlement_failed** (a2uTxid OR horizonSuccessFlag) | Terminal | ❌ No (blocked) | ❌ No | ❌ No | Must use `/api/recovery/[id]` |

## PERMANENT BLOCKING FLAGS

**Once set, these PERMANENTLY block client retry and Horizon resubmission:**
- `a2uTxid` — Horizon transaction sent, even if failed
- `horizonSuccessFlag` — Horizon accepted the transaction (confirmed on-chain)

**Rule:** If either flag exists → **No client-side repayment possible**

## INTERNAL SETTLEMENT STAGE

`settlementStage` is INTERNAL only, NOT part of public status:
- `pending_signing` → Building A2U transaction
- `sign_pending` → Waiting for ledger signature  
- `complete_pending` → Waiting for Pi /complete call
- `completed` → A2U fully settled

The public `status` field always reflects the actual business state, never internal staging.

## AFFECTED FILES & ENFORCEMENT POINTS

### 1. **lib/types.ts** ✅ CORRECT
- Defines 7-value `PaymentStatus` enum
- `settlementStage` separate from `status`
- Terminal flags: `a2uTxid`, `horizonSuccessFlag`

### 2. **lib/payment-status.ts** ✅ CORRECT
- `VALID_STATUSES` enforces 7-value enum
- `isProcessingStatus()` → true for `paid_to_app`, `settlement_pending`
- `isPaid()` → true ONLY for `settled_to_merchant`
- `isTerminalState()` → checks `a2uTxid` OR `horizonSuccessFlag`
- `canClientRetryPayment()` → blocks if terminal

### 3. **lib/retry-decision.ts** ✅ CORRECT
- Single authoritative retry decision function
- Blocks retry for `paid_to_app`, `settlement_pending`
- Routes terminal states to server recovery
- Guards against `a2uTxid` and `horizonSuccessFlag`

### 4. **app/api/payments/route.ts** — NEEDS AUDIT
- **Must NOT** allow U2A creation for `paid_to_app` or `settlement_pending`
- **Must** validate incoming status against VALID_STATUSES
- **Must NOT** mutate `a2uTxid` or `horizonSuccessFlag` without atomic transaction

### 5. **app/api/pi/a2u/route.ts** — NEEDS AUDIT
- **Must NOT** set `a2uTxid` unless Horizon succeeded
- **Must** set `horizonSuccessFlag` only after Horizon accepts
- **Must NOT** start new A2U if `paid_to_app` exists
- **Must** reject requests with a2uTxid present (recovery logic only)

### 6. **app/api/pi/complete/route.ts** — NEEDS AUDIT
- **Must NOT** call Pi /complete for `paid_to_app` (only for `settlement_pending`)
- **Must** verify payment not already in `settled_to_merchant`
- **Must** check `piCompleted` flag before redundant call

### 7. **app/api/recovery/[id]/route.ts** — NEEDS AUDIT
- **Must** check `isTerminalState(payment)` before starting recovery
- **Must** skip Horizon if `a2uTxid` exists
- **Must** skip Pi /complete if `piCompleted` flag set
- **Must** use `/api/transactions` for DB reconciliation only

### 8. **components/customer-payment-view.tsx** — NEEDS AUDIT
- **Must NOT** allow repay button for `paid_to_app` or `settlement_pending`
- **Must** show "Processing..." for processing states
- **Must** show retry button ONLY if `canClientRetryPayment()` true
- **Must** show recovery link if `isTerminalState()` true

### 9. **lib/a2u-executor.ts** — NEEDS AUDIT
- **Must** skip Stage 2 (Horizon) if `a2uTxid` exists
- **Must** skip Stage 3 (Pi /complete) if `piCompleted` true
- **Must NOT** allow entry to DB stage if financial data invalid
- **Must** set `dbRecorded=true` ONLY after DB commit + Redis save

### 10. **lib/a2u-recovery-service.ts** — NEEDS AUDIT
- **Must** verify `isTerminalState()` at entry
- **Must** route to executor only with `isRecovery: true`
- **Must NOT** allow client U2A creation
- **Must** poll payment status after A2U success

### 11. **lib/unified-store.ts** — NEEDS AUDIT
- **Must NOT** allow `status` mutations that violate transitions
- **Must** validate `status` against VALID_STATUSES before save
- **Must** never downgrade `settled_to_merchant` to any other status

### 12. **lib/use-payments.ts** — NEEDS AUDIT
- **Must** block `startPayment()` if `paid_to_app` or `settlement_pending`
- **Must** route poll requests for processing states
- **Must** route retry requests through `getRetryDecision()`

### 13. **lib/use-settlements.ts** — NEEDS AUDIT
- **Must** only count `settled_to_merchant` as paid volume
- **Must** show processing states as "In Progress"
- **Must** show failure states with retry option (except terminal)

### 14. **lib/use-load-payment-history.ts** — NEEDS AUDIT
- **Must** filter `settled_to_merchant` for paid analytics
- **Must NOT** include processing states in settled count
- **Must** tag terminal failures for manual review display

## ENFORCEMENT CHECKLIST

- [ ] All 14 files reviewed for status contradictions
- [ ] No file allows `paid_to_app` or `settlement_pending` client retry
- [ ] All files reject `a2uTxid` presence for new Horizon submission
- [ ] All files route terminal states to server recovery
- [ ] `settled_to_merchant` is final and immutable across all code paths
- [ ] `settlementStage` is internal only, never exposed as public status
- [ ] Polling is enforced for processing states, no client retry
- [ ] Only `pending` allows fresh U2A creation
- [ ] All retry decisions go through `getRetryDecision()` function
- [ ] All status mutations validated against VALID_STATUSES
- [ ] No ambiguous/contradictory status checks remain
- [ ] Terminal flag guards (`a2uTxid`, `horizonSuccessFlag`) enforced everywhere
