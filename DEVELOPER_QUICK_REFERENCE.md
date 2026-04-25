# FlashPay Transfer System - Developer Quick Reference

## File Structure

```
/lib
  ├── transfer-service.ts          # Core transfer logic, retry, notifications
  ├── transfer-report-service.ts   # Reporting, export, analytics
  ├── notification-service.ts      # In-app notifications & sounds
  ├── db.ts                        # Database layer (updated)
  └── config.ts                    # Pi Network config

/app/api/transfers
  ├── process/route.ts             # Main API endpoint (POST/GET/PUT)
  └── export/route.ts              # Export endpoint (CSV/JSON)

/app/merchant
  └── transfers/page.tsx           # Merchant dashboard

/app
  └── profile/page.tsx             # Updated with transfer link

Scripts & Docs
├── TRANSFER_SYSTEM_COMPLETE.md    # Full documentation
├── TRANSFER_SYSTEM_IMPLEMENTATION.md # Implementation details
└── SETUP_CHECKLIST.md             # Deployment checklist
```

## Key Functions

### Transfer Service
```typescript
executeTransfer(transferId, merchantAddress, amount, memo?)
  → Executes Pi API transfer
  → Returns { success, piTransferId?, error? }

retryTransfer(transferId)
  → Retries failed transfer with backoff
  → Checks retry_count, timing, status
  → Returns { success, error? }

processPendingTransfers()
  → Batch processes all pending transfers
  → Called by background jobs or manually
  → Returns { processed, successful, failed }
```

### Database Layer
```typescript
createTransferRequest(transactionId, merchantId, address, amount)
  → Creates transfer record
  → Status: PENDING

getTransfersByMerchant(merchantId, limit)
  → Fetches all transfers for merchant
  → Returns array sorted by created_at DESC

updateTransferStatus(transferId, status, piTransferId?, errorMessage?)
  → Updates transfer record
  → Increments retry_count
  → Sets timestamps

getPendingTransfers(limit)
  → Gets transfers with status PENDING or FAILED
  → Used for batch retry processing
```

### Notification Service
```typescript
notifyTransferSuccess(transferId, amount, merchantName?)
notifyTransferFailed(transferId, reason, retryAvailable)
notifyTransferRetry(transferId, attempt, maxAttempts)
notifyTransferPending(amount, merchantName?)
notifyPaymentComplete(amount, merchantName?)
  → All return Notification object
  → Play sound + store in localStorage

getNotifications()
  → Returns all notifications

getUnreadNotifications()
  → Returns unread only

clearAllNotifications()
  → Clear all stored notifications
```

### Report Service
```typescript
generateTransferReport(merchantId)
  → Returns comprehensive stats

exportTransfersToCSV(merchantId)
  → Returns CSV string

exportTransfersToJSON(merchantId)
  → Returns JSON object

getTransferHistory(merchantId, page, pageSize)
  → Paginated transfer list

generateStatement(merchantId, startDate, endDate)
  → Period-specific report
```

## API Endpoints

### POST /api/transfers/process
**Create transfer request**

Request:
```json
{
  "transactionId": "uuid",
  "merchantId": "merchant_123",
  "merchantAddress": "merchant_wallet_address",
  "amount": 50.5
}
```

Response (202):
```json
{
  "success": true,
  "transferId": "transfer_uuid",
  "message": "Transfer initiated and queued for processing"
}
```

### GET /api/transfers/process?merchantId=XXX&limit=50
**Fetch transfer history**

Response (200):
```json
{
  "transfers": [...],
  "stats": {
    "total": 142,
    "completed": 139,
    "pending": 2,
    "processing": 1,
    "failed": 0,
    "totalAmount": 7250.50,
    "completedAmount": 7150.00,
    "pendingAmount": 100.50,
    "failedAmount": 0,
    "successRate": 97.9
  },
  "merchantId": "merchant_123"
}
```

### PUT /api/transfers/process
**Retry failed transfer**

Request:
```json
{
  "transferId": "transfer_uuid"
}
```

Response (200):
```json
{
  "success": true,
  "message": "Transfer retry initiated",
  "transferId": "transfer_uuid"
}
```

### GET /api/transfers/export?format=csv&merchantId=XXX
**Export transfers**

Formats:
- `format=csv` - Downloads CSV file
- `format=json` - Downloads JSON file
- Add `&startDate=2024-01-01&endDate=2024-12-31` for date range

## Status Flow Diagram

```
PENDING ──(execute)──→ PROCESSING ──(success)──→ COMPLETED
   ↓                                   ↓
   └─(execute fail)─→ FAILED ──(retry)──┘
                      ↓
                (max retries) → FAILED (final)
```

## Integration Points

### 1. Payment Completion (in `/app/api/pi/complete/route.ts`)
```typescript
// After transaction recorded
initiateTransferAsync(
  result.transactionId,
  paymentForRecording.merchantId,
  existingPayment.merchantAddress,
  paymentForRecording.amount
).catch(console.error)
```

### 2. Profile Page Navigation (in `/app/profile/page.tsx`)
```typescript
<Button onClick={() => router.push("/merchant/transfers")}>
  View Transfer Status
</Button>
```

### 3. Payment Recording (in transaction service)
```typescript
// Transfer record created automatically by:
createTransferRequest(...)
```

## Error Handling

Common errors and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| "Merchant wallet address required" | Empty address | Check payment has merchant wallet |
| "Failed to create transfer record" | DB error | Check database connection |
| "Max retries exceeded" | 5 failures | Investigate Pi API issues |
| "Too soon to retry" | Backoff active | Wait for exponential backoff |
| "Transfer not found" | Invalid transferId | Verify UUID format |

## Debugging Tips

### Enable Debug Logs
```typescript
// Already included with [Transfer] prefix
console.log('[Transfer] ...')
```

### Check Transfer Status
```sql
SELECT id, status, amount, retry_count, error_message, created_at 
FROM transfers 
WHERE merchant_id = 'merchant_123'
ORDER BY created_at DESC
LIMIT 20;
```

### Test Transfer Manually
```bash
curl -X POST http://localhost:3000/api/transfers/process \
  -H "Content-Type: application/json" \
  -d '{
    "transactionId": "test-uuid",
    "merchantId": "merchant_123",
    "merchantAddress": "merchant_address",
    "amount": 10
  }'
```

### View Browser Notifications
```javascript
// In browser console
import { getNotifications } from '@/lib/notification-service'
console.log(getNotifications())
```

## Performance Optimization

- Database queries use indexes on (merchant_id, status, created_at)
- Transfer execution is non-blocking
- Dashboard auto-refresh: 10 seconds
- Export limit: 500 records per query
- Batch retry: processes 50 at a time

## Migration to Mainnet

1. Update environment variables:
   ```
   PI_API_KEY = mainnet_key
   PI_WALLET_SEED = mainnet_seed
   ```

2. No code changes required - API endpoint same
3. Database schema unchanged
4. All logic works identically

## Testing Strategies

### Unit Tests (Future)
```typescript
test('executeTransfer with valid data')
test('retryTransfer respects backoff timing')
test('notification sounds play correctly')
test('CSV export formats correctly')
```

### Integration Tests (Future)
```typescript
test('Payment completion triggers transfer')
test('Dashboard shows correct statistics')
test('Export includes all transfers')
test('Manual retry works after failure')
```

### Manual Testing
1. Create test payment for 1 Pi
2. Wait for transfer to complete (should be <2 seconds)
3. Verify dashboard shows COMPLETED
4. Export and verify data
5. Simulate failure and test retry

## Resources

- **Main Docs:** `/TRANSFER_SYSTEM_COMPLETE.md`
- **Setup:** `/SETUP_CHECKLIST.md`
- **Code:** `/lib/transfer-service.ts`
- **Pi API:** https://developers.minepi.com/docs/

## Support

For issues, check:
1. `/TRANSFER_SYSTEM_COMPLETE.md` - Full documentation
2. Browser console logs
3. Database for error_message field
4. Dashboard transfer status

---

**Quick Start:**
1. Set up environment variables
2. Run database migration
3. Deploy code
4. Monitor first transfers
5. Celebrate! 🎉

**Version:** 1.0.0
**Last Updated:** 2024-04-19
