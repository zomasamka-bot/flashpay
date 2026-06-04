# A2U Critical Fee and Stuck Payment Fix

## Summary

Three critical issues fixed in `/app/api/pi/a2u/route.ts`:

1. **tx_insufficient_fee** - Transaction fee was hardcoded to Stellar's BASE_FEE constant (100 stroops), which Horizon rejects
2. **Stuck payment auto-reuse** - System was automatically reusing old stuck A2U payments without checking status
3. **Missing diagnostic logs** - Fee information wasn't logged during Horizon errors, making debugging impossible

## Fixes Applied

### Fix 1: Dynamic Fee Calculation (Both Payment Paths)

Now fetches base fee from Horizon and uses 2x that amount, ensuring the transaction is accepted by the network instead of being rejected with `tx_insufficient_fee`.

**Impact**: Transactions now use network's current fee rate multiplied by 2, eliminating fee-related rejections.

### Fix 2: Ongoing Payment Status Validation

Added validation before reusing stuck payments. Checks if ongoing payment is in FAILED, CANCELLED, or PENDING states without proper approvals. Stuck payments are now rejected with `requiresManualIntervention: true`.

**Impact**: Stuck payments like `bwLSDtOIPCl2oUv42AhoqSqa38Fn` are identified and rejected before causing cascading failures.

### Fix 3: Enhanced Horizon Error Diagnostics

Added detailed logging showing:
- Base fee fetched from Horizon
- Fee used in transaction
- Complete Horizon error response with result codes and XDR

**Impact**: When `tx_insufficient_fee` or other errors occur, logs clearly show fee information and exact Stellar error codes for immediate diagnosis.

## Files Modified

- `/app/api/pi/a2u/route.ts`:
  - Lines 333-368: Ongoing payment status validation before reuse
  - Lines 476-499: Dynamic fee calculation (ongoing payment path)
  - Lines 556-557, 573, 595-596: Enhanced error logging with fees
  - Lines 943-966: Dynamic fee calculation (new payment path)
  - Lines 1023-1024, 1040, 1062-1063: Enhanced error logging with fees

## Backward Compatibility

- User-to-App (U2A) customer payment flow: UNCHANGED
- A2U settlement flow: FIXED with proper fee handling
- All changes isolated to A2U route handler only
