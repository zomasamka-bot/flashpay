# STAGE 2: UNIFIED INTERNAL RESULT CONTRACT

## Executive Summary
**Status**: Implementation Ready
**Scope**: Unify ALL executor stage internal result contracts; remove obsolete success-based internal branches
**Public Contract**: NO CHANGE (remains `{ success: false, status: string, error: string }`)
**Implementation Target**: lib/a2u-executor.ts and all callers

---

## Current State Analysis

### Problem: Dual Result Systems
Current implementation uses **two incompatible internal result contracts**:

1. **Stage functions return discriminated unions** (ok-based):
   ```typescript
   { ok: false; success: false; status: string; error: string }
   { ok: true; data: { a2uPaymentId: string; ... } }
   ```

2. **Main executor returns single type** (success-based):
   ```typescript
   { success: false; status: string; error: string }
   ```

### Consequence: Complexity & Risk
- Stage results require `ok` check BEFORE accessing data
- Main result never uses `ok` field (confusing caller perspective)
- Three separate error paths in each stage
- Inconsistent pattern makes future maintenance harder
- Recovery flows re-implement error handling logic

---

## UNIFIED CONTRACT: Single Discriminated Union

### NEW INTERNAL RESULT TYPE
```typescript
type StageResult = 
  | { ok: true; data: { [key: string]: unknown } }
  | { ok: false; error: string; userFacingStatus: string }
```

**Rules:**
- **ALL stages return this type** (Stage 1-4, executor)
- `ok: true` → data provided, proceed to next stage
- `ok: false` → error, userFacingStatus tells caller what to return to user
- NO success field in internal flow
- NO optional fields (discriminated union precision)

### MAIN EXECUTOR RETURN (Unchanged - Public Contract)
```typescript
type ExecutorResult = {
  success: false
  status: string
  error: string
}
```
- Same as today
- buildA2USuccessResponse() transforms internal ok:true → success:true/false

---

## Removal: Obsolete Success-Based Branches

### Old Stage Pattern (REMOVE):
```typescript
async function stage1CreateA2U(): Promise<
  { ok: false; success: false; status: string; error: string } |
  { ok: true; data: { ... } }
>
```
↓ **REPLACE WITH:**
```typescript
async function stage1CreateA2U(): Promise<StageResult>
```

### Translation Map
| Old | New | Behavior |
|-----|-----|----------|
| `{ ok: false, success: false, status: X, error: Y }` | `{ ok: false, error: Y, userFacingStatus: X }` | Error branch |
| `{ ok: true, data: { ... } }` | `{ ok: true, data: { ... } }` | Success branch |

### Removed Redundancy
- `success: false` field (replaced by `ok: false`)
- Duplicate `status` in both ok branches (now only in `ok: false`)
- Three error returns per stage become ONE: `{ ok: false, error, userFacingStatus }`

---

## Stage 1: Create A2U

### Current (Redundant):
```typescript
// 2 fields in every error: status + success
return { ok: false, success: false, status: "error", error: "..." }
```

### New (Unified):
```typescript
// 1 field in every error: userFacingStatus replaces status
return { ok: false, error: "Failed to create A2U payment", userFacingStatus: "error" }
```

**Call sites updated:**
- UID verification failure
- A2U creation failure
- Ongoing payment detection (still ok: true with reused ID)
- Type validation failure

---

## Stage 2: Sign & Submit

### Current (Redundant):
```typescript
return { ok: false, success: false, status: "settlement_pending", error: "..." }
```

### New (Unified):
```typescript
return { ok: false, error: "...", userFacingStatus: "settlement_pending" }
```

**Call sites updated:**
- Missing a2uToAddress
- Missing merchantAmount
- Missing a2uPaymentId
- PI_PRIVATE_SEED not configured
- Address mismatch
- Horizon connection failed
- Account loading failed
- Transaction submission failed

---

## Stage 3: Complete Pi

### Current (Redundant):
```typescript
return { ok: false, success: false, status: "error", error: "..." }
```

### New (Unified):
```typescript
return { ok: false, error: "...", userFacingStatus: "error" }
```

**Call sites updated:**
- Missing a2uPaymentId
- Missing txidFromHorizon
- HTTP request failed
- Response validation failed
- Missing developer_completed flag
- Missing verified flag

---

## Stage 4: DB Reconciliation

### Current (Redundant):
```typescript
return { ok: false, success: false, status: "error", error: "..." }
```

### New (Unified):
```typescript
return { ok: false, error: "...", userFacingStatus: "error" }
```

**Call sites updated:**
- Missing txidFromHorizon
- DB transaction failed
- Metadata record failed

---

## Main Executor Flow

### Caller Pattern (New):
```typescript
const stageResult = await stage1CreateA2U(ctx)

if (!stageResult.ok) {
  // Handle error - userFacingStatus tells caller what user sees
  return {
    success: false,
    status: stageResult.userFacingStatus,
    error: stageResult.error
  }
}

// Access data - guaranteed not undefined
const a2uPaymentId = stageResult.data.a2uPaymentId
```

### Benefits:
- No `success` check needed (internal consistency)
- No optional data access (TypeScript narrows automatically)
- Every error path follows same pattern
- Consistent with recovery flows

---

## Implementation Checklist

- [ ] Define unified `StageResult` type
- [ ] Update Stage 1 signatures and all error returns
- [ ] Update Stage 2 signatures and all error returns
- [ ] Update Stage 3 signatures and all error returns
- [ ] Update Stage 4 signatures and all error returns
- [ ] Update main executor caller pattern (remove `success` checks)
- [ ] Test recovery flow with new contracts
- [ ] Remove any leftover `success: false` from internal paths
- [ ] Verify public contract unchanged (POST handler returns same shape)

---

## Factual Changes Summary

| Component | Lines | Change |
|-----------|-------|--------|
| Type definitions | ~5 | Add StageResult unified type |
| Stage 1 | ~15 | Replace all `{ ok: false, success: false, status, error }` |
| Stage 2 | ~20 | Replace all `{ ok: false, success: false, status, error }` |
| Stage 3 | ~8 | Replace all `{ ok: false, success: false, status, error }` |
| Stage 4 | ~5 | Replace all `{ ok: false, success: false, status, error }` |
| Main executor | ~12 | Update caller pattern to use `userFacingStatus` |
| Removed | ~30 | Lines with redundant `success: false` field |
| **Total** | **~65** | Net refactor (consolidates, doesn't expand) |

---

## Verification

**Public API Remains Identical:**
- Input: `POST /api/pi/a2u` with `{ paymentId }`
- Output: `{ success, status, error, ... }` (same fields)

**Internal Consistency Improved:**
- All stages use same result shape
- No dual-system branches in recovery flows
- Fewer error paths to maintain
- Clearer intent: `ok: true` for success, `ok: false` for errors

---

## Backward Compatibility

- ✓ Public route contract unchanged
- ✓ Database schema unchanged
- ✓ Redis storage format unchanged
- ✓ buildA2USuccessResponse() unchanged
- ✓ Payment status values unchanged
- ✓ Internal API (executeA2U context) unchanged

Only internal result contracts unified—no breaking changes for callers.
