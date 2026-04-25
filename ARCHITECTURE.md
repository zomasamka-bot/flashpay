# FlashPay Transfer System - Architecture Overview

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FLASHPAY APPLICATION                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    USER INTERFACE LAYER                      │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │                                                              │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌────────────┐  │  │
│  │  │   Home Page     │  │ Create Payment  │  │   Profile  │  │  │
│  │  │   (Landing)     │  │   (QR + Link)   │  │   (User)   │  │  │
│  │  └────────┬────────┘  └────────┬────────┘  └──────┬─────┘  │  │
│  │           │                    │                  │         │  │
│  │           └────────────────────┼──────────────────┘         │  │
│  │                                │                            │  │
│  │  ┌──────────────────────────────▼──────────────────────┐    │  │
│  │  │                                                     │    │  │
│  │  │  ┌─────────────────────────────────────────────┐   │    │  │
│  │  │  │  MERCHANT TRANSFERS DASHBOARD              │   │    │  │
│  │  │  │  ├─ Transfer History (Real-time)           │   │    │  │
│  │  │  │  ├─ Statistics (Total, Pending, Failed)    │   │    │  │
│  │  │  │  ├─ Manual Retry Button                    │   │    │  │
│  │  │  │  ├─ Export CSV/JSON                        │   │    │  │
│  │  │  │  └─ Copy to Clipboard                      │   │    │  │
│  │  │  └─────────────────────────────────────────────┘   │    │  │
│  │  │                                                     │    │  │
│  │  └─────────────────────────────────────────────────────┘    │  │
│  │                                                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                  NOTIFICATION LAYER                          │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │                                                              │  │
│  │  ┌────────────────┐  ┌────────────────┐  ┌────────────┐   │  │
│  │  │  In-App Toast  │  │  Browser Notif │  │  Sound     │   │  │
│  │  │  (Success/Fail)│  │  (with badge)  │  │  Alerts    │   │  │
│  │  └────────────────┘  └────────────────┘  └────────────┘   │  │
│  │                                                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      API LAYER (Next.js Routes)                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌────────────────────────┐  ┌────────────────────────┐            │
│  │  POST /api/transfers   │  │  GET /api/transfers    │            │
│  │  - Create transfer     │  │  - Fetch history       │            │
│  │  - Validate data       │  │  - Get statistics      │            │
│  │  - Return 202 Accepted │  │  - Calculate totals    │            │
│  └────────┬───────────────┘  └────────┬───────────────┘            │
│           │                           │                            │
│  ┌────────┴───────────────┐  ┌────────┴───────────────┐            │
│  │  PUT /api/transfers    │  │  GET /api/transfers/ex │            │
│  │  - Retry failed        │  │  - Export CSV/JSON     │            │
│  │  - Check retry limits  │  │  - Generate reports    │            │
│  │  - Update status       │  │  - Download file       │            │
│  └───────────────────────┘  └────────────────────────┘            │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                    │              │              │
        ┌───────────┴──────────────┼──────────────┴───────────┐
        │                          │                          │
        ▼                          ▼                          ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ BUSINESS LOGIC   │      │  DATA ACCESS     │      │  PI NETWORK      │
│   SERVICES       │      │    SERVICES      │      │    SERVICES      │
├──────────────────┤      ├──────────────────┤      ├──────────────────┤
│                  │      │                  │      │                  │
│ Transfer Service │      │ Database Layer   │      │ Pi SDK/API       │
│ ├─ Execute       │      │ ├─ Create        │      │ ├─ Transfers     │
│ ├─ Retry logic   │      │ ├─ Read          │      │ ├─ Wallet API    │
│ ├─ Status update │      │ ├─ Update        │      │ ├─ Testnet       │
│ └─ Error handle  │      │ └─ Delete        │      │ └─ Mainnet       │
│                  │      │                  │      │                  │
│ Notification Srv │      │ Redis Cache      │      │ Pi Auth          │
│ ├─ Toast         │      │ ├─ Sessions      │      │ ├─ API Key       │
│ ├─ Browser notif │      │ ├─ Counters      │      │ ├─ Signatures    │
│ └─ Sound alerts  │      │ └─ Temp data     │      │ └─ Verification  │
│                  │      │                  │      │                  │
│ Report Service   │      │                  │      │                  │
│ ├─ CSV export    │      │                  │      │                  │
│ ├─ JSON export   │      │                  │      │                  │
│ └─ Statistics    │      │                  │      │                  │
│                  │      │                  │      │                  │
└──────────────────┘      └──────────────────┘      └──────────────────┘
        │                         │                         │
        │         ┌───────────────┼───────────────┐         │
        │         │               │               │         │
        ▼         ▼               ▼               ▼         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    EXTERNAL SERVICES & DATA                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────┐   │
│  │   PostgreSQL     │  │   Upstash Redis  │  │  Pi Network    │   │
│  │   (Neon)         │  │   (Cache)        │  │  Testnet API   │   │
│  │                  │  │                  │  │                │   │
│  │  Tables:         │  │  Session data    │  │  Transfers API │   │
│  │  ├─ transfers    │  │  Counter values  │  │  ├─ POST /..   │   │
│  │  ├─ transactions │  │  Temp storage    │  │  ├─ GET /...   │   │
│  │  ├─ merchants    │  │                  │  │  └─ Webhook    │   │
│  │  └─ payments     │  │  TTL: 24 hours   │  │                │   │
│  │                  │  │                  │  │  https://api.  │   │
│  │  Backup: Daily   │  │                  │  │  minepi.com    │   │
│  │  Retention: 90d  │  │                  │  │                │   │
│  │                  │  │                  │  │  Environment:  │   │
│  │  Encryption: On  │  │  Auto-expiry: On │  │  Testnet now   │   │
│  │                  │  │                  │  │  Mainnet later │   │
│  └──────────────────┘  └──────────────────┘  └────────────────┘   │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow: Complete Payment to Transfer

```
1. USER CREATES PAYMENT
   └─> User enters amount + note
       └─> Generate unique link + QR code
           └─> Store in memory/cache

2. USER SHARES LINK/QR
   └─> Merchant shares with customer
       └─> Customer opens link in Pi Browser

3. CUSTOMER SEES PAYMENT
   └─> /pay/[paymentId] page loads
       └─> Displays merchant + amount
           └─> Shows "Pay Now" button

4. CUSTOMER PAYS
   └─> Clicks "Pay Now"
       └─> Pi Wallet opens (Testnet)
           └─> Customer approves
               └─> Pi executes payment
                   └─> Webhook sent to /api/pi/approve

5. SYSTEM RECORDS PAYMENT
   └─> [Pi Webhook] APPROVE received
       └─> Payment validated
           └─> Stored in Redis + PostgreSQL
               └─> Merchant notified

6. PAYMENT COMPLETION
   └─> [Pi Webhook] COMPLETE received
       └─> Payment marked as PAID
           └─> Status updated in database
               └─> Merchant sees "PAID" status

7. TRANSFER INITIATED (Automatic)
   └─> Transfer service triggered
       └─> New transfer record created (PENDING)
           └─> Call Pi API: POST /v2/wallet/transfers
               └─> Send funds to merchant wallet
                   └─> Status updated to PROCESSING

8. TRANSFER COMPLETES
   └─> Pi API returns success
       └─> Transfer status → COMPLETED
           └─> Pi Transfer ID recorded
               └─> Notification sent to user
                   └─> Sound alert plays
                       └─> Dashboard updates

9. MERCHANT MONITORS
   └─> Opens Profile → Fund Transfers
       └─> Sees transfer with status COMPLETED
           └─> Can export history
               └─> Can download CSV/JSON report

10. AUTO-RETRY ON FAILURE
    └─> If transfer fails
        └─> System retries automatically
            ├─> Attempt 1: Immediate (2s delay)
            ├─> Attempt 2: After 2s (5s delay)
            ├─> Attempt 3: After 5s (10s delay)
            ├─> Attempt 4: After 10s (30s delay)
            └─> Attempt 5: After 30s (60s delay)
                └─> After 5 attempts: Status → FAILED
                    └─> Merchant can manually retry
```

## Transfer Status State Machine

```
                    ┌─────────────┐
                    │   PENDING   │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ PROCESSING  │ ◄─── Executing Pi API call
                    └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    │             │
                    ▼             ▼
            ┌─────────────┐  ┌──────────┐
            │ COMPLETED   │  │  FAILED  │
            │  (Success)  │  │ (Error)  │
            └─────────────┘  └──────┬───┘
                                    │
                        ┌───────────┘
                        │
                ┌───────▼────────┐
                │  Manual Retry  │
                │    Button      │
                └───────┬────────┘
                        │
                        ▼
                ┌─────────────┐
                │  PROCESSING │ ◄─── Re-attempt
                └──────┬──────┘
                       │
                ┌──────┴──────┐
                │             │
                ▼             ▼
            ┌─────────────┐  ┌──────────────┐
            │ COMPLETED   │  │  FAILED      │
            │  (Success)  │  │  (Max retry) │
            └─────────────┘  └──────────────┘
                                    │
                            ┌───────▴──────────┐
                            │                  │
                      [Contact Support]   [Manual Review]
```

## Automatic Retry Timeline

```
Payment Completion
    │
    ├─ T+0ms ────────► Transfer created (PENDING)
    │
    ├─ T+100ms ──────► Pi API called (PROCESSING)
    │
    ├─ T+500ms ──────► [Success] Status → COMPLETED ✓
    │
    └─ T+500ms ──────► [Failure] Start retry sequence
         │
         ├─ T+2s ────────► Retry Attempt 1
         │  │
         │  └─ Success ───► COMPLETED ✓
         │  └─ Failure ───► Next attempt
         │
         ├─ T+7s ────────► Retry Attempt 2 (5s backoff)
         │  │
         │  └─ Success ───► COMPLETED ✓
         │  └─ Failure ───► Next attempt
         │
         ├─ T+17s ───────► Retry Attempt 3 (10s backoff)
         │  │
         │  └─ Success ───► COMPLETED ✓
         │  └─ Failure ───► Next attempt
         │
         ├─ T+47s ───────► Retry Attempt 4 (30s backoff)
         │  │
         │  └─ Success ───► COMPLETED ✓
         │  └─ Failure ───► Next attempt
         │
         ├─ T+107s ──────► Retry Attempt 5 (60s backoff)
         │  │
         │  └─ Success ───► COMPLETED ✓
         │  └─ Failure ───► FAILED (Max retries reached)
         │
         └─ Merchant can manually retry
            or contact support
```

## Component Dependencies

```
Payment Flow (Existing - Unchanged)
    └─> /api/pi/approve
        └─> /api/pi/complete
            └─> [NEW] initiateTransferAsync()

Transfer System (New - Modular)
    ├─ /app/merchant/transfers/page.tsx (UI)
    │   ├─> /lib/transfer-service.ts
    │   ├─> /lib/notification-service.ts
    │   ├─> /lib/transfer-report-service.ts
    │   └─> /lib/db.ts (transfers functions)
    │
    ├─ /app/api/transfers/process/route.ts (API)
    │   ├─> POST: Create transfer
    │   ├─> GET: List transfers + stats
    │   ├─> PUT: Retry transfer
    │   └─> Dependencies: transfer-service, db
    │
    ├─ /app/api/transfers/export/route.ts (API)
    │   ├─> GET: Export CSV/JSON
    │   └─> Dependencies: transfer-report-service
    │
    └─ Background Processing (Optional)
        └─> Cron job to retry pending transfers
            └─> Dependencies: transfer-service, db

All services are independent and can be tested separately.
```

## Environment Variables Flow

```
User provides environment variables
    │
    ├─ PI_API_KEY ───────────► /lib/config.ts
    │  (Set in Vercel)         └─> Used in: transfer-service.ts
    │
    ├─ DATABASE_URL ──────────► /lib/config.ts
    │  (PostgreSQL/Neon)       └─> Used in: db.ts, transfer-report-service.ts
    │
    ├─ UPSTASH_REDIS_REST_URL ► /lib/config.ts
    │  (Redis)                 └─> Used in: transfer-service.ts, cache
    │
    ├─ PI_TESTNET_WALLET_ADDRESS ► /lib/config.ts
    │  (Merchant wallet)       └─> Used in: transfer-service.ts
    │
    └─ [More env vars...]     ► /lib/config.ts
                               └─> Central configuration source

All environment access goes through /lib/config.ts
Never read process.env directly elsewhere!
```

## Summary

- **Modular Architecture**: Each service has single responsibility
- **Non-Blocking Design**: Transfer doesn't block payment completion
- **Persistent Storage**: PostgreSQL for audit trail, Redis for cache
- **Automatic Recovery**: 5-attempt retry with exponential backoff
- **Real-Time Monitoring**: Dashboard updates every 10 seconds
- **Future-Ready**: Easy to add email, webhooks, analytics later
- **Testnet to Mainnet**: Just change one environment variable

**Result: Production-grade system ready to scale.**
