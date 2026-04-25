# Verification Guide - Bug Fixes

## Pre-Testing Checklist

Before testing, ensure:
- Merchant setup is complete with wallet address configured
- Pi Testnet is properly configured
- Database schema has been initialized
- Redis is configured and accessible

---

## Test 1: Verify Payment History Pagination

**Objective:** Confirm all payments are returned (not just one record)

**Steps:**

1. Create 5 test payments with different amounts:
   - 0.1 Pi
   - 0.2 Pi
   - 0.5 Pi
   - 1.0 Pi
   - 2.0 Pi

2. Navigate to Payments page

3. **Expected Results:**
   - All 5 payments appear in history
   - Payments are sorted by newest first (reverse creation order)
   - Pagination shows correct total count
   - Each payment displays amount, status, creation time

4. **Verification Logs:**
   - Check `/app/merchant/payments/page.tsx` console logs
   - Should show all transactions being loaded from database
   - No "limit to 1" or similar restrictions

5. **Database Query Check:**
   - Verify SQL query uses parameterized LIMIT/OFFSET
   - Should see: `LIMIT $N OFFSET $M` (not hardcoded values)

---

## Test 2: Verify Transfer Execution

**Objective:** Confirm transfers execute after payment completion

**Steps:**

1. **Pre-Condition:** Complete merchant setup with Pi Testnet wallet address

2. Create a new payment request (0.1 Pi recommended)

3. Complete payment via Pi Wallet (Testnet)

4. Check console logs immediately after payment:
   - Should see: "Cannot initiate transfer - no merchant wallet address" ❌ **SHOULD NOT APPEAR**
   - Should see: "Transfer initiated successfully" ✅

5. Navigate to Fund Transfers dashboard

6. **Expected Results:**
   - Transfer appears with status PENDING (within 1 second)
   - Status changes to COMPLETED (within 5-10 seconds)
   - Transaction shows correct merchant wallet address
   - Amount matches payment amount

7. **Verification Logs:**
   - Check `/app/api/pi/complete/route.ts` logs
   - Should show: `"Background: Initiating transfer to merchant wallet"`
   - Should show: `"Transfer initiated successfully"`
   - Should NOT show: `"Cannot initiate transfer - no merchant wallet address"`

---

## Test 3: Verify Payment Object Structure

**Objective:** Confirm merchantAddress is properly stored in payment

**Steps:**

1. Create a payment request

2. Before completing payment, check Redis:
   ```bash
   redis-cli GET payment:YOUR_PAYMENT_ID
   ```

3. **Expected Results:**
   - Payment object includes `"merchantAddress": "YOUR_WALLET_ADDRESS"`
   - All fields present: id, merchantId, merchantAddress, amount, note, status, createdAt
   - merchantAddress is NOT empty or null

4. **Verification in Code:**
   - Check `/app/api/payments/route.ts` logs after payment creation
   - Should show: `"Has merchantAddress: true Value: WALLET_ADDRESS"`
   - Should show: `"JSON includes 'merchantAddress': true"`

---

## Test 4: Error Handling - Missing Wallet Address

**Objective:** Verify clear error if merchant setup incomplete

**Steps:**

1. Create a new merchant session (clear storage if needed)

2. Try to create payment WITHOUT completing merchant setup

3. **Expected Result:**
   - Error message: "Merchant wallet not configured. Please complete setup."
   - Payment creation blocked
   - Clear indication to user to complete setup

4. **Verification:**
   - Check operations.ts logs: `"Merchant wallet address not set"`
   - User guided to profile setup

---

## Test 5: Data Isolation - Multiple Merchants

**Objective:** Confirm merchant data remains isolated

**Steps:**

1. Create payment as Merchant A (0.1 Pi)

2. Switch to Merchant B (different merchantId)

3. View payment history in Merchant B

4. **Expected Result:**
   - Merchant B's payment history is EMPTY
   - Merchant A's payment doesn't appear
   - Each merchant sees ONLY their own payments

5. Verify database query:
   - Should include `WHERE merchant_id = $1`
   - Only merchant's own transactions returned

---

## Test 6: Complete End-to-End Flow

**Objective:** Test entire payment + transfer flow

**Steps:**

1. **Setup:** Complete merchant setup with Pi Testnet wallet

2. **Create Payment:**
   ```
   Amount: 0.5 Pi
   Note: "Test transfer execution"
   ```
   - Verify payment shows in history
   - Status: PENDING

3. **Complete Payment:**
   - Open payment via QR code or link
   - Complete via Pi Wallet (Testnet)
   - Wait for "Payment Complete" notification

4. **Verify Transfer:**
   - Navigate to Fund Transfers
   - New transfer should appear with status PENDING
   - Wait 5-10 seconds
   - Status should change to COMPLETED
   - Verify amount matches: 0.5 Pi

5. **Check Records:**
   - Payment history shows payment as PAID
   - Fund Transfers shows transfer as COMPLETED
   - Both show consistent merchant wallet address

---

## Logs to Monitor

### During Payment Creation
```
[API] PAYMENT CREATION REQUEST RECEIVED
[API] Has merchantAddress: true
[API] JSON includes 'merchantAddress': true
```

### During Payment Completion
```
[Pi Webhook] PAYMENT RETRIEVED FROM REDIS
[Pi Webhook] Background: Initiating transfer to merchant wallet
[Pi Webhook] Background: Transfer initiated successfully
```

### During Transfer Processing
```
[Transfer] Starting transfer to merchant wallet
[Transfer] Transfer successful
Transfer status updated to COMPLETED
```

### Errors to NOT See
```
❌ "Cannot initiate transfer - no merchant wallet address"
❌ "merchantAddress is missing"
❌ "CRITICAL: merchantAddress was lost"
```

---

## Rollback Procedures

If issues occur:

1. **Payment History Issue:**
   - Revert `/lib/db.ts` `getTransactionsByMerchant()` function
   - Restart application

2. **Transfer Issue:**
   - Revert `/lib/operations.ts` changes
   - Revert `/app/api/payments/route.ts` changes
   - Clear Redis cache if needed

3. **Database Issues:**
   - Check database logs for query errors
   - Verify database schema created correctly
   - Ensure merchantId column exists in transactions table

---

## Success Criteria

All tests pass when:
- ✅ Multiple payments visible in history
- ✅ Transfers execute after payment
- ✅ No "Cannot initiate transfer" errors
- ✅ Merchant data properly isolated
- ✅ All fields properly persisted
- ✅ Console logs show expected flow
- ✅ Correct wallet addresses in all records

---

## Production Deployment

Once verified in staging:

1. Run full test suite
2. Monitor transfer success rate (target: >95%)
3. Monitor payment history retrieval times
4. Check database performance with full load
5. Deploy to production with monitoring enabled
6. Watch first 24 hours for any issues
