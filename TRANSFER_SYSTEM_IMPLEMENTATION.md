# Fund Transfer System Implementation - Complete Guide

## Overview
This document describes the fund transfer system that has been implemented for FlashPay. The system automatically transfers funds from the app wallet to merchant wallets after successful Pi Network payments, with automatic retry logic and a merchant dashboard for monitoring.

## Architecture

### Database Layer
**New Table: `transfers`**
- Tracks all fund transfers from app wallet → merchant wallet
- Stores status (pending, processing, completed, failed)
- Records retry attempts and error messages
- Fields: `id`, `transaction_id`, `merchant_id`, `merchant_address`, `amount`, `status`, `pi_transfer_id`, `created_at`, `completed_at`, `error_message`, `retry_count`, `last_retry_at`

### Services

#### 1. Transfer Service (`/lib/transfer-service.ts`)
**Purpose:** Core business logic for executing Pi Network wallet transfers

**Key Functions:**
- `executeTransfer()` - Execute wallet-to-wallet transfer via Pi API
  - Calls `https://api.minepi.com/v2/wallet/transfers` (Testnet)
  - Handles both success and error responses
  - Updates database with result

- `retryTransfer()` - Retry failed transfers with exponential backoff
  - Respects max retries (5 attempts)
  - Implements exponential backoff: 2s, 5s, 10s, 30s, 60s
  - Prevents retrying too soon

- `processPendingTransfers()` - Batch process pending/failed transfers
  - Call this periodically (every 5-10 minutes recommended)
  - Can be integrated with a background job service

#### 2. Transfer API (`/app/api/transfers/process/route.ts`)

**POST** - Create and initiate transfer
```
POST /api/transfers/process
Body: {
  transactionId: string,
  merchantId: string,
  merchantAddress: string,
  amount: number
}
Response: { success: true, transferId: string } (202 Accepted)
```
- Non-blocking (returns immediately)
- Executes transfer in background
- Returns 202 to indicate async operation

**GET** - Fetch transfer history for a merchant
```
GET /api/transfers/process?merchantId=XXX&limit=50
Response: {
  transfers: Transfer[],
  stats: {
    total, pending, processing, completed, failed,
    totalCompleted, totalPending
  }
}
```

**PUT** - Manually retry a failed transfer
```
PUT /api/transfers/process?transferId=XXX
Response: { success: true }
```

### Integration Point
**File:** `/app/api/pi/complete/route.ts`

When payment completion flow records the transaction:
```
recordTransactionToPG() → then:
  initiateTransferAsync(transactionId, merchantId, merchantAddress, amount)
    → POST /api/transfers/process (fire-and-forget)
```

## Payment Flow with Transfers

```
1. Payment Created
   ↓
2. Payment Approved (Pi SDK)
   ↓
3. Payment Completed (Pi SDK)
   ↓
4. Transaction Recorded (Redis + PostgreSQL)
   ↓
5. Transfer Initiated (Fire-and-Forget)
   ├── Create transfer record (PENDING)
   ├── Execute Pi API call (async)
   └── Update transfer status (COMPLETED/FAILED)
   ↓
6. User sees completion immediately
   (Transfer happens in background)
```

## Merchant Dashboard

**Route:** `/app/merchant/transfers/page.tsx`

**Features:**
- Real-time transfer statistics (total, completed, pending, failed)
- Transfer history with detailed information
- Status badges (pending, processing, completed, failed)
- Error messages for failed transfers
- Manual retry button for failed transfers
- Auto-refresh every 10 seconds
- Wallet address and retry count visibility

**Access:** Profile page → "Fund Transfers" button

## Configuration & Setup

### Environment Variables
None new required - uses existing `PI_API_KEY`

### Database Migration
Run the initialization script to create the `transfers` table:
```bash
npx ts-node scripts/init-db.ts
```

### Background Job (Optional but Recommended)
For automatic retry processing, set up a cron job to call:
```
POST /api/transfers/process (process all pending)
or
PUT /api/transfers/process?transferId=XXX (retry specific)
```

Example with Vercel Crons:
```json
// vercel.json
{
  "crons": [{
    "path": "/api/transfers/retry-pending",
    "schedule": "*/5 * * * *"  // Every 5 minutes
  }]
}
```

## Reliability & Error Handling

### Automatic Retry Strategy
- **Max Attempts:** 5
- **Backoff:** Exponential (2s, 5s, 10s, 30s, 60s)
- **Failure Conditions:** Network errors, API rate limits (429), server errors (5xx)
- **Manual Retry:** Merchants can retry failed transfers via dashboard

### Idempotency
- Each transfer has a unique `pi_transfer_id` from Pi API
- Pi API prevents duplicate transfers to the same wallet
- Database ensures one transfer record per transaction

### Non-Blocking Design
- Transfer execution doesn't block payment completion flow
- If transfer fails, payment is already recorded as successful
- User sees payment completion immediately
- Transfers happen asynchronously in background

## Testnet Specifics

### Pi Testnet Transfer API
- **Endpoint:** `https://api.minepi.com/v2/wallet/transfers`
- **Authentication:** `Authorization: Key {PI_API_KEY}`
- **Testnet Behavior:** Transfers are instant (no approval needed)
- **Wallet Addresses:** Use Testnet wallet addresses from Pi Developer Portal

### Testing Transfers
1. Create a payment → Approve → Complete
2. Check `/merchant/transfers` dashboard
3. Verify transfer status updates to "completed"
4. Check Pi Testnet wallet receives funds

## API Responses

### Transfer Success
```json
{
  "success": true,
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Transfer initiated and queued for processing"
}
```

### Transfer History
```json
{
  "transfers": [{
    "id": "550e8400-...",
    "transaction_id": "550e8400-...",
    "merchant_id": "merchant_123",
    "merchant_address": "GCX...",
    "amount": 10.50,
    "status": "completed",
    "pi_transfer_id": "pi_txn_...",
    "created_at": "2024-01-15T10:30:00Z",
    "completed_at": "2024-01-15T10:31:00Z",
    "retry_count": 0
  }],
  "stats": {
    "total": 15,
    "pending": 1,
    "processing": 0,
    "completed": 13,
    "failed": 1,
    "totalCompleted": 125.50,
    "totalPending": 5.00
  }
}
```

## Monitoring & Debugging

### Log Messages
Transfer operations log to console with `[Transfer]` prefix:
```
[Transfer] Starting transfer to merchant wallet
[Transfer] Transfer successful
[Transfer] Retry failed: Too soon to retry
[Transfer] Max retries exceeded
```

### Database Queries
```sql
-- Get all pending transfers
SELECT * FROM transfers WHERE status IN ('pending', 'failed') ORDER BY created_at ASC;

-- Get merchant transfer history
SELECT * FROM transfers WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 50;

-- Get transfer statistics
SELECT status, COUNT(*) as count, SUM(amount) as total 
FROM transfers GROUP BY status;
```

### Troubleshooting

**Transfer stuck in PENDING:**
- Check network connectivity
- Verify merchant wallet address is valid
- Check Pi API key configuration
- Wait for automatic retry (exponential backoff)
- Manual retry via dashboard

**Transfer failed with error:**
- Check error message in dashboard
- Verify merchant wallet address
- Check Pi Testnet wallet has capacity
- Retry manually or wait for automatic retry

**No transfers appearing:**
- Ensure payment was actually completed
- Check database `transfers` table exists
- Verify `CREATE TABLE transfers` script ran
- Check Pi API key is configured

## Security Considerations

1. **API Key:** Pi API key should be environment variable only (never hardcoded)
2. **Merchant Address:** Validated before transfer execution
3. **Amount Validation:** Must match transaction amount
4. **Retry Limits:** Prevents infinite retry loops
5. **Database Queries:** Parameterized queries prevent SQL injection
6. **Idempotency:** Pi API prevents duplicate transfers

## Future Enhancements

1. **Batch Transfers:** Group multiple merchant transfers into single API call
2. **Settlement Windows:** Schedule transfers for specific times (e.g., daily)
3. **Advanced Analytics:** Transfer success rates, average times, volume trends
4. **Webhooks:** Notify merchants when transfers complete
5. **Multi-Wallet Support:** Allow merchants to have multiple receiving wallets
6. **Transfer Scheduling:** Let merchants choose when transfers happen
7. **Fee Management:** Track and report transfer fees
8. **Audit Trail:** Complete history of all transfer operations

## Maintenance

### Database Cleanup
Old completed transfers can be archived:
```sql
-- Archive completed transfers older than 90 days
INSERT INTO transfer_archive SELECT * FROM transfers 
WHERE status = 'completed' AND completed_at < NOW() - INTERVAL '90 days';

DELETE FROM transfers 
WHERE status = 'completed' AND completed_at < NOW() - INTERVAL '90 days';
```

### Monitoring Health
Check transfer success rate periodically:
```sql
SELECT 
  COUNT(*) as total,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
  ROUND(100.0 * SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) / COUNT(*), 2) as success_rate
FROM transfers 
WHERE created_at > NOW() - INTERVAL '7 days';
```
