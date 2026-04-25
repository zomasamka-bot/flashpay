# Transfer Execution Logging Guide

## Overview
The transfer execution now logs every step of the A2U (App-To-User) payment process to Pi Network with complete details.

## Log Flow

### 1. Transfer Initiation
When a payment completes successfully, the system initiates a transfer to the merchant's wallet:

```
[Pi Webhook] Background: Initiating transfer to merchant wallet
[Transfers API] Background transfer starting for transferId: xxx-xxx-xxx
```

### 2. Transfer Service Execution

#### STEP 1: Create A2U Payment
```
[Transfer] ========================================
[Transfer] TRANSFER EXECUTION STARTED
[Transfer]   transferId: xxx-xxx-xxx
[Transfer]   merchantAddress (uid): 12345...
[Transfer]   amount: 1.5
[Transfer]   memo: FlashPay payout
[Transfer] ========================================

[Transfer] STEP 1: Creating A2U payment...
[Transfer] Sending A2U Payment to: https://api.minepi.com/v2/payments
[Transfer] Request Headers: {
  Authorization: 'Key abc123def456...',
  'Content-Type': 'application/json'
}
[Transfer] Request Body: {
  "payment": {
    "amount": 1.5,
    "memo": "FlashPay payout",
    "metadata": {
      "transferId": "xxx-xxx-xxx",
      "type": "merchant_payout"
    },
    "uid": "12345..."
  }
}

[Transfer] ========== STEP 1 RESPONSE ==========
[Transfer] Status Code: 201
[Transfer] Status OK: true
[Transfer] Response Headers: {
  contentType: 'application/json',
  contentLength: '234'
}
[Transfer] Response Body: {
  "payment": {
    "identifier": "payment_123abc",
    "uid": "12345...",
    "amount": 1.5,
    "memo": "FlashPay payout",
    "status": "CREATED"
  }
}
[Transfer] ======================================
[Transfer] ✓ A2U Payment created: payment_123abc
```

#### STEP 2: Approve the Payment
```
[Transfer] STEP 2: Approving A2U payment...
[Transfer] URL: https://api.minepi.com/v2/payments/payment_123abc/approve
[Transfer] Request Body: {}

[Transfer] ========== STEP 2 RESPONSE ==========
[Transfer] Status Code: 200
[Transfer] Status OK: true
[Transfer] Response Body: {
  "payment": {
    "identifier": "payment_123abc",
    "status": "APPROVED"
  }
}
[Transfer] ======================================
[Transfer] ✓ A2U Payment approved
```

#### STEP 3: Complete the Payment
```
[Transfer] STEP 3: Completing A2U payment with txid...
[Transfer] URL: https://api.minepi.com/v2/payments/payment_123abc/complete
[Transfer] Request Body: {
  "txid": "payment_123abc-1234567890"
}

[Transfer] ========== STEP 3 RESPONSE ==========
[Transfer] Status Code: 200
[Transfer] Status OK: true
[Transfer] Response Headers: {
  contentType: 'application/json',
  contentLength: '456'
}
[Transfer] Response Body: {
  "payment": {
    "identifier": "payment_123abc",
    "status": "COMPLETED",
    "txid": "payment_123abc-1234567890"
  }
}
[Transfer] ======================================
```

### 3. Final Result Summary
```
[Transfer] ========================================
[Transfer] ✓ TRANSFER SUCCESSFUL
[Transfer]   transferId: xxx-xxx-xxx
[Transfer]   piPaymentId: payment_123abc
[Transfer]   amount: 1.5
[Transfer]   merchantAddress (uid): 12345...
[Transfer] ========================================

[Transfers API] ========================================
[Transfers API] TRANSFER EXECUTION RESULT
[Transfers API] transferId: xxx-xxx-xxx
[Transfers API] merchantAddress: 12345...
[Transfers API] amount: 1.5
[Transfers API] success: true
[Transfers API] piTransferId: payment_123abc
[Transfers API] error: (none)
[Transfers API] ========================================
```

## Error Scenarios

### Scenario 1: Step 1 Fails (Create A2U Payment)
```
[Transfer] Step 1 Response:
[Transfer]   Status Code: 400
[Transfer]   Status OK: false
[Transfer]   Response Body: {
  "error": {
    "message": "Invalid uid format",
    "code": "INVALID_REQUEST"
  }
}

[Transfer] A2U Payment creation failed: {
  status: 400,
  error: "Invalid uid format",
  fullResponse: {...}
}

[Transfer] ❌ Transfer FAILED
```

### Scenario 2: Step 2 Fails (Approval)
```
[Transfer] Step 2 Response:
[Transfer]   Status Code: 403
[Transfer]   Status OK: false
[Transfer]   Response Body: {
  "error": {
    "message": "Insufficient app wallet balance",
    "code": "INSUFFICIENT_BALANCE"
  }
}

[Transfer] A2U Payment approval failed: {
  status: 403,
  error: "Insufficient app wallet balance",
  fullResponse: {...}
}

[Transfer] ❌ Transfer FAILED
```

## Key Information to Log for Troubleshooting

1. **transferId** - Your internal transfer identifier
2. **merchantAddress (uid)** - Pi's user identifier for the merchant
3. **amount** - Transfer amount in Pi
4. **piPaymentId** - Pi's payment identifier (created in Step 1)

5. **HTTP Status Codes**:
   - 201: Step 1 success (Created)
   - 200: Steps 2 & 3 success (OK)
   - 400: Bad request (check payload)
   - 403: Forbidden (check balance, permissions)
   - 404: Not found (check payment ID in Step 2/3)
   - 500: Server error on Pi side

## Next Steps

When transfers complete (success or failure), the logs above will show:
1. What was sent to Pi API (endpoint, payload, headers)
2. What Pi API responded with (status, body, headers)
3. Final success/failure status with transaction details

Use these logs to:
- Verify the correct merchant UID was used
- Check Pi API response for specific error messages
- Track transfer IDs through the payment lifecycle
- Debug any API integration issues
