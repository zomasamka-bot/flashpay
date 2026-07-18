# STATUS & RETRY DECISION MATRIX
## Single Source of Truth for All Status Routing

---

## 📊 COMPREHENSIVE DECISION TABLE

```
┌──────────────────────┬──────────┬────────────┬────────────┬──────────┬──────────────────┬─────────────────────┐
│ Current Status       │ Category │ Can Retry? │ Can Poll?  │ Can U2A? │ Blocking Flags   │ Next Action         │
├──────────────────────┼──────────┼────────────┼────────────┼──────────┼──────────────────┼─────────────────────┤
│ pending              │ Fresh    │ ❌ No*     │ ✅ Yes (5s)│ ✅ Yes  │ None             │ Show retry button   │
│                      │          │ *awaiting  │            │          │                  │ or poll             │
├──────────────────────┼──────────┼────────────┼────────────┼──────────┼──────────────────┼─────────────────────┤
│ failed               │ Error    │ ✅ YES     │ ❌ No      │ ✅ Yes  │ None             │ Show retry button   │
│                      │          │ (pre-U2A)  │            │          │                  │ (new payment)       │
├──────────────────────┼──────────┼────────────┼────────────┼──────────┼──────────────────┼─────────────────────┤
│ cancelled            │ Cancel   │ ✅ YES     │ ❌ No      │ ✅ Yes  │ None             │ Show retry button   │
│                      │          │ (by user)  │            │          │                  │ (new payment)       │
├──────────────────────┼──────────┼────────────┼────────────┼──────────┼──────────────────┼─────────────────────┤
│ paid_to_app          │Process   │ ❌ BLOCKED │ ✅ Long*   │ ❌ No   │ — (processing)   │ Show "Processing..."│
│                      │ (In-flt) │ (NOT error)│ (30-60s)   │          │                  │ with spinner        │
├──────────────────────┼──────────┼────────────┼────────────┼──────────┼──────────────────┼─────────────────────┤
│ settlement_pending   │ Process  │ ❌ BLOCKED │ ✅ Long*   │ ❌ No   │ — (processing)   │ Show "Processing..."│
│                      │ (In-flt) │ (NOT error)│ (30-60s)   │          │                  │ with spinner        │
├──────────────────────┼──────────┼────────────┼────────────┼──────────┼──────────────────┼─────────────────────┤
│ settled_to_merchant  │ ✅ FIN   │ ❌ NO      │ ❌ NO      │ ❌ No   │ — (immutable)    │ Show "Paid" badge   │
│                      │ SUCCESS  │ (final)    │ (final)    │          │                  │ + receipt           │
├──────────────────────┼──────────┼────────────┼────────────┼──────────┼──────────────────┼─────────────────────┤
│ settlement_failed    │ Error    │ ✅ YES*    │ ❌ No      │ ✅ Yes* │ None (yet)       │ Show retry button   │
│ (no a2uTxid)         │ (recov)  │ *if no     │            │ *new     │                  │ (new payment)       │
│                      │          │ a2uTxid    │            │          │                  │                     │
├──────────────────────┼──────────┼────────────┼────────────┼──────────┼──────────────────┼─────────────────────┤
│ settlement_failed    │ Terminal │ ❌ BLOCKED │ ❌ No      │ ❌ No   │ a2uTxid ✓         │ Show recovery link  │
│ (+ a2uTxid)          │ (ON-CHAIN)│(on-chain) │            │          │ OR                │ → /api/recovery/[id]│
│                      │          │            │            │          │ horizonSuccessFlag│                     │
└──────────────────────┴──────────┴────────────┴────────────┴──────────┴──────────────────┴─────────────────────┘
```

---

## 🔴 HARD BLOCKING RULES

### Rule 1: Terminal Flags Block Everything
**If `a2uTxid` exists OR `horizonSuccessFlag` true:**
- ❌ NO client retry allowed (blocked)
- ❌ NO fresh U2A creation
- ❌ NO Horizon resubmission
- ✅ ONLY server recovery via `/api/recovery/[id]`

**Permanent blocking applies to:**
- `settlement_failed` with a2uTxid (transaction sent to Horizon)
- `settlement_failed` with horizonSuccessFlag (Horizon accepted it)

### Rule 2: Processing States Block Client Retry
**Status `paid_to_app` OR `settlement_pending`:**
- ❌ NOT a failure state (don't show error)
- ❌ NO client retry button
- ✅ ONLY server polling allowed
- ✅ Show "Processing..." with spinner

### Rule 3: Only `pending` May Start U2A
**Fresh U2A creation allowed ONLY if:**
- `status === "pending"` AND
- `a2uTxid` is undefined AND
- `horizonSuccessFlag` is false

### Rule 4: settled_to_merchant is Immutable
**Once `status === "settled_to_merchant"`:**
- ❌ NEVER downgrade to any other status
- ❌ NEVER retry or re-settle
- ✅ Final accounting complete
- ✅ Counted as paid volume

### Rule 5: No settlementStage in Public API
**Internal only:**
- `settlementStage` values: pending_signing, sign_pending, complete_pending, completed
- NOT exposed in API responses
- NOT shown in UI
- Server-side tracking only

---

## 🎯 ROUTING DECISION FLOW

### For Client Retry Click

```
payment = fetch from Redis
  ↓
if (a2uTxid OR horizonSuccessFlag)
  → 🔴 BLOCKED: Show recovery link (/api/recovery/[id])
  ↓
else if (status === "paid_to_app" OR "settlement_pending")
  → 🔴 BLOCKED: Show "Processing" with poll spinner
  ↓
else if (status === "settled_to_merchant")
  → 🔴 BLOCKED: Show "Already paid" (no action)
  ↓
else if (getRetryDecision().canRetry === true)
  → ✅ ALLOWED: Enable retry button (new U2A)
  ↓
else
  → 🔴 BLOCKED: Show error message
```

### For Payment Poll/Refresh

```
payment = fetch from Redis
  ↓
if (status === "paid_to_app" OR "settlement_pending")
  → ✅ POLL: Call /api/payments/[id] long-poll (30-60s)
  ↓
else if (a2uTxid OR horizonSuccessFlag)
  → 🟠 RECOVERY: Route to /api/recovery/[id] (server-side)
  ↓
else if (status === "settled_to_merchant")
  → ⏹️  STOP: Payment final, no polling needed
  ↓
else
  → ⏹️  STOP: Payment not in processing state
```

### For Create Fresh U2A

```
if (status !== "pending")
  → 🔴 REJECT: Current status doesn't allow fresh U2A
  ↓
if (a2uTxid exists)
  → 🔴 REJECT: Payment already submitted to Horizon
  ↓
if (horizonSuccessFlag === true)
  → 🔴 REJECT: Horizon already processed, use recovery
  ↓
else
  → ✅ ALLOW: Call /api/pi/approve for fresh Pi Wallet
```

---

## 📋 ENFORCEMENT CHECKLIST

### Status Validation (Entry Point)
- [ ] Check payment.status against VALID_STATUSES enum
- [ ] Reject unknown statuses with 400 error
- [ ] Log all status transitions with from/to values

### Terminal Flag Guards (Before Operations)
- [ ] Check if a2uTxid exists before any new operation
- [ ] Check if horizonSuccessFlag=true before any new operation
- [ ] If either flag exists → BLOCK client retry immediately
- [ ] Log terminal flag presence for audit trail

### Processing State Handling
- [ ] If status="paid_to_app" → SHOW POLL SPINNER
- [ ] If status="settlement_pending" → SHOW POLL SPINNER
- [ ] Do NOT show retry button for processing states
- [ ] Do NOT show error message (not a failure)

### Final State Immutability
- [ ] If status="settled_to_merchant" → NO mutations
- [ ] If downgrade attempted → THROW ERROR
- [ ] Log any downgrade attempts with full context
- [ ] Preserve all identifiers in settled state

### Polling Rules
- [ ] Enforce poll interval 30-60s for processing states
- [ ] Stop polling on settled_to_merchant
- [ ] Stop polling on terminal states
- [ ] Route terminal states to recovery, not poll

### Fresh U2A Creation
- [ ] Reject if status !== "pending"
- [ ] Reject if a2uTxid exists
- [ ] Reject if horizonSuccessFlag=true
- [ ] Allow ONLY if all guards pass

---

## 📌 AFFECTED FILES & DECISION POINT

| File | Decision Point | Rule | Status |
|------|----------------|------|--------|
| lib/payment-status.ts | isProcessingStatus() | Rule 2 | ✅ |
| lib/payment-status.ts | isTerminalState() | Rule 1 | ✅ |
| lib/payment-status.ts | isPaid() | Rule 4 | ✅ |
| lib/retry-decision.ts | getRetryDecision() | Rules 1,2 | ✅ |
| app/api/payments/route.ts | POST create | Rule 5 | ✅ |
| app/api/pi/approve/route.ts | POST approve | Rule 3 | ✅ |
| app/api/pi/a2u/route.ts | POST settlement | Rules 1,5 | ✅ |
| app/api/pi/complete/route.ts | POST complete | Rules 2,4 | ✅ |
| app/api/recovery/[id]/route.ts | POST recovery | Rule 1 | ✅ |
| components/customer-payment-view.tsx | Retry button | Rules 1,2 | ✅ |
| lib/unified-store.ts | Status mutations | Rules 1,4 | ✅ |
| lib/use-payments.ts | startPayment() | Rule 3 | ✅ |
| lib/use-settlements.ts | Analytics count | Rule 4 | ✅ |
| lib/use-load-payment-history.ts | History filter | Rule 4 | ✅ |

---

## 🎓 EXAMPLES BY STATUS

### Example 1: Fresh Payment (pending)
```
Status: pending
Action: Show retry button (new U2A)
Reason: Fresh payment, not yet processed
```

### Example 2: Processing U2A (paid_to_app)
```
Status: paid_to_app
a2uTxid: undefined
Action: Show "Processing..." spinner, poll /api/payments/[id]
Reason: U2A done, settling A2U in progress
```

### Example 3: Horizon Sent (settlement_failed + a2uTxid)
```
Status: settlement_failed
a2uTxid: "abcd1234..."
horizonSuccessFlag: false
Action: Show recovery link → /api/recovery/[id]
Reason: Horizon received transaction, must recover server-side
```

### Example 4: Horizon Confirmed (settlement_failed + horizonSuccessFlag)
```
Status: settlement_failed
a2uTxid: "abcd1234..."
horizonSuccessFlag: true
Action: Show recovery link → /api/recovery/[id]
Reason: Horizon confirmed, must complete settlement server-side
```

### Example 5: Final Success (settled_to_merchant)
```
Status: settled_to_merchant
a2uTxid: "abcd1234..."
Action: Show "Paid" badge + receipt, no further action
Reason: Settlement complete, immutable final state
```

---

END OF DECISION MATRIX
