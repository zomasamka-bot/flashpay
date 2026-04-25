# FlashPay Fund Transfer System - Complete Setup Guide

## Overview

This guide walks through the complete setup of the automated fund transfer system for FlashPay. The system handles:

- **Automatic fund transfers** from app wallet to merchant wallets after payment completion
- **Robust retry logic** with exponential backoff for failed transfers
- **In-app notifications** with sound alerts for transfer status
- **Merchant dashboard** for transfer history and reporting
- **Export functionality** for CSV/JSON reports
- **Background job processing** for continuous retry management

## Architecture

```
Payment Completion
    ↓
PostgreSQL Transaction Record
    ↓
Transfer Record Created (PENDING)
    ↓
Async Pi Wallet Transfer
    ↓
Status Update (COMPLETED/FAILED)
    ↓
In-app Notification + Sound
    ↓
Background Job Retry (if failed)
```

## Environment Variables

### Required for Testnet

```bash
# Pi Network Configuration
PI_API_KEY=your_pi_api_key_here
PI_ENVIRONMENT=testnet
PI_TESTNET_WALLET_ADDRESS=your_app_wallet_pi_address
PI_TESTNET_PRIVATE_KEY=your_app_wallet_private_key  # Optional, for signing

# Database
DATABASE_URL=postgresql://user:password@host/database

# Redis (for payment storage)
UPSTASH_REDIS_REST_URL=your_redis_url
UPSTASH_REDIS_REST_TOKEN=your_redis_token

# Background Job Security
TRANSFER_JOB_SECRET=your_secret_key_for_cron_jobs

# App URL
NEXT_PUBLIC_APP_URL=https://your-vercel-app.vercel.app

# Email (Optional, for future email notifications)
EMAIL_PROVIDER=sendgrid
EMAIL_API_KEY=your_email_api_key
EMAIL_FROM_ADDRESS=noreply@flashpay.pi
```

## Setup Steps

### 1. Database Migration

Run the database migration to create the transfers and notifications tables:

```bash
npm run migrate:transfers
# Or manually:
npx tsx scripts/setup-transfers-table.mjs
```

This creates:
- `transfers` table - tracks all fund transfers
- `transfer_notifications` table - tracks notification history
- Indexes for optimal query performance

### 2. Configure Environment Variables

Add all required environment variables to your Vercel project:

```bash
# In Vercel Dashboard > Settings > Environment Variables
PI_API_KEY=...
PI_ENVIRONMENT=testnet
PI_TESTNET_WALLET_ADDRESS=...
DATABASE_URL=...
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
TRANSFER_JOB_SECRET=your_secure_random_string
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
```

### 3. Verify Configuration

Check that all systems are configured:

```bash
curl https://your-app.vercel.app/api/config/check
```

Response should show:
```json
{
  "redis": true,
  "postgres": true,
  "piApi": true,
  "piTestnet": true
}
```

### 4. Set Up Background Jobs

#### Option A: Vercel Cron Jobs (Recommended)

Create `vercel.json` in your project root:

```json
{
  "crons": [
    {
      "path": "/api/jobs/process-transfers",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

This runs the transfer processing job every 5 minutes.

#### Option B: External Cron Service

Use a service like EasyCron, AWS EventBridge, or GitHub Actions to call:

```bash
curl -X GET https://your-app.vercel.app/api/jobs/process-transfers \
  -H "Authorization: Bearer your_transfer_job_secret"
```

### 5. Test the System

#### Test 1: Create a test payment

```bash
curl -X POST https://your-app.vercel.app/api/pi/create \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 0.1,
    "description": "Test transfer",
    "merchantId": "test-merchant"
  }'
```

#### Test 2: Approve and complete the payment

Use the Pi Testnet SDK to approve and complete the payment.

#### Test 3: Verify transfer

Check the merchant dashboard at `/merchant/transfers` to see:
- Transfer status (should show COMPLETED or PROCESSING)
- In-app notification with sound
- Amount transferred

#### Test 4: Check database

```sql
SELECT * FROM transfers WHERE merchant_id = 'test-merchant';
SELECT * FROM transfer_notifications WHERE merchant_id = 'test-merchant';
```

## Features

### Automatic Retries

When a transfer fails, the system automatically retries with exponential backoff:

- Attempt 1: 2 seconds
- Attempt 2: 5 seconds
- Attempt 3: 10 seconds
- Attempt 4: 30 seconds
- Attempt 5: 60 seconds

After 5 attempts, the transfer is marked as FAILED and requires manual intervention.

### In-App Notifications

Transfer status changes trigger notifications with:
- **Success**: Green badge + notification sound
- **Failed**: Red badge + error message
- **Retry**: Yellow badge + retry count
- **Processing**: Blue spinning icon

### Merchant Dashboard

Access at `/merchant/transfers` to:
- View all transfers with live status
- Filter by status (All, Completed, Processing, Pending, Failed)
- Search by transfer ID, address, or Pi transfer ID
- Copy IDs to clipboard
- Manually retry failed transfers
- Export history as CSV or JSON
- View statistics (total, completed, failed, etc.)

### Export Reports

#### CSV Format

```
Transfer ID,Status,Amount (Pi),Merchant Address,Pi Transfer ID,Created At,Completed At,Error Message,Retry Count
"uuid1","completed","1.50","wallet_address","pi_transfer_id1","2024-01-15T10:30:00Z","2024-01-15T10:30:05Z","","0"
...
```

#### JSON Format

```json
{
  "merchantId": "merchant123",
  "exportDate": "2024-01-15T10:30:00Z",
  "totalTransfers": 100,
  "totalAmount": 150.50,
  "transfers": [...]
}
```

## Monitoring & Debugging

### Check Transfer Status

```sql
SELECT 
  status,
  COUNT(*) as count,
  SUM(amount) as total_amount
FROM transfers
WHERE merchant_id = 'your_merchant_id'
GROUP BY status;
```

### View Failed Transfers

```sql
SELECT * FROM transfers
WHERE status = 'failed' AND retry_count < 5
ORDER BY created_at DESC;
```

### View Recent Notifications

```sql
SELECT * FROM transfer_notifications
WHERE merchant_id = 'your_merchant_id'
ORDER BY created_at DESC
LIMIT 20;
```

### Check Background Job Logs

View Vercel logs:
```bash
vercel logs https://your-app.vercel.app/api/jobs/process-transfers
```

## Future Enhancements

### Email Notifications (Planned)

When enabled, merchants will receive email notifications for:
- Transfer successful
- Transfer failed (with retry info)
- All retries exhausted

Enable in environment:
```bash
EMAIL_PROVIDER=sendgrid
EMAIL_API_KEY=your_key
```

### Settlement Batching

Future: Group multiple transfers into settlement batches for efficiency.

### Multi-Chain Support

Future: Support transfers to different blockchain addresses or networks.

### Advanced Analytics

Future: Add charts, export reports, and settlement analytics.

## Troubleshooting

### Transfers stuck in PENDING

1. Check if background job is running:
   ```
   curl https://your-app.vercel.app/api/jobs/process-transfers \
     -H "Authorization: Bearer your_transfer_job_secret"
   ```

2. Check logs for errors:
   ```
   vercel logs [deployment-url]
   ```

3. Manually retry via dashboard

### Notifications not showing

1. Verify database is configured: `DATABASE_URL` set
2. Check browser console for errors
3. Verify notifications table exists: `SELECT * FROM transfer_notifications LIMIT 1;`

### Transfer API returning 500

1. Check `DATABASE_URL` is set and accessible
2. Verify `transfers` table exists
3. Check Vercel logs for detailed error

### Low success rate

1. Check if Pi API key is valid
2. Verify merchant wallet addresses are correct
3. Check if Pi Testnet is experiencing issues

## Security Considerations

### Data Isolation

- Each merchant can only view their own transfers
- Transactions stored in isolated database schema
- API validates merchant ID on every request

### Rate Limiting

Background job is designed to:
- Process max 50 transfers per run
- Run every 5 minutes (max 240 transfers/hour)
- Implement exponential backoff to avoid overwhelming Pi API

### Error Handling

- All errors logged but not exposed to frontend
- Sensitive data (private keys) never logged
- Secure environment variable handling

## Mainnet Migration

When ready to move to Mainnet:

1. Update environment:
   ```bash
   PI_ENVIRONMENT=mainnet
   ```

2. Update merchant wallet addresses to Mainnet addresses

3. Test thoroughly with small amounts first

4. Monitor transfers closely for first 24 hours

5. Gradually increase transfer volume

## Support & Monitoring

### Key Metrics to Monitor

- Transfer success rate (target: >99%)
- Average transfer completion time
- Failed transfer count
- Notification delivery rate

### Dashboards

- Merchant dashboard: `/merchant/transfers`
- Admin analytics: (planned)

### Alerts

Set up alerts for:
- More than 5 failed transfers in a row
- Transfer processing time >60 seconds
- Database connection errors

## Additional Resources

- Pi Network API: https://docs.minepi.com
- PostgreSQL Docs: https://www.postgresql.org/docs/
- Vercel Cron Jobs: https://vercel.com/docs/cron-jobs
- FlashPay Dashboard: `/merchant/transfers`
