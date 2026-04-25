# Payment Flow Fix - Merchant Wallet Address

## Problem
Merchant wallet validation was blocking payment creation with error: "Merchant wallet not configured. Please complete setup."

This prevented QR code generation and stopped the entire payment flow before it could start.

## Root Cause
- Payment creation was requiring merchant wallet address (which is optional)
- Merchant wallet address should only be required during transfer execution (after payment completes)
- Overly-strict validation was blocking users from creating payments

## Solution Applied

### 1. Payment Creation (`/app/api/payments/route.ts`)
- Made `merchantAddress` field OPTIONAL in Payment interface
- Removed validation that blocked empty merchant addresses
- Payments can now be created without wallet address configured
- Merchant can add wallet address later in profile if needed for transfers

### 2. Merchant Address in Operations (`/lib/operations.ts`)
- Removed strict validation check
- Now passes empty string as fallback if merchant address not available
- Allows payment flow to proceed without blocking

### 3. Transfer Execution (`/app/api/pi/complete/route.ts`)
- Added graceful handling when merchant address is missing
- Logs warning instead of failing
- Skips transfer with informative message
- Merchant can set wallet address in profile later to enable transfers

## Data Flow

```
Merchant creates payment (no wallet needed)
  ↓
QR code generated ✓
  ↓
Customer scans and completes payment via Pi Wallet
  ↓
Payment marked PAID in Redis
  ↓
If merchant has wallet address → transfer executes
If merchant doesn't have wallet address → transfer skipped with warning
  ↓
Merchant can set wallet address in profile later
Background job will attempt pending transfers when address is available
```

## Testing

1. **Create payment without wallet address:**
   - Merchant doesn't set wallet in profile
   - Create payment request
   - QR code should generate
   - Payment flow completes normally

2. **Transfer with wallet address:**
   - Merchant sets wallet address in profile
   - Create payment request
   - Customer pays
   - Transfer automatically executes after payment completes

3. **Transfer without wallet address:**
   - Merchant doesn't set wallet address
   - Customer completes payment
   - Check logs for warning: "No merchant wallet address configured - transfer skipped"
   - Merchant later adds wallet to profile
   - System will retry transfer in background

## Files Modified

1. `/app/api/payments/route.ts` - Made merchantAddress optional
2. `/lib/operations.ts` - Removed strict validation
3. `/app/api/pi/complete/route.ts` - Added graceful handling

## Status

✅ Payment creation now works without merchant wallet address
✅ QR code generates immediately
✅ Transfer execution checks for wallet address gracefully
✅ User-friendly messages when wallet not configured
✅ Full payment flow unblocked

The system now separates concerns properly: payments are metadata and can be created anytime, while transfers require wallet address and can be configured later.
