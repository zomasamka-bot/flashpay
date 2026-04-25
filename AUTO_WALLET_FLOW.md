# Automatic Wallet Address Flow Diagram

## Complete System Flow (No Manual Entry)

```
┌─────────────────────────────────────────────────────────────────────┐
│ MERCHANT OPENS APP IN PI BROWSER                                    │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 1: SDK INITIALIZATION                                          │
│  • /lib/pi-sdk.ts: initializePiSDK()                                │
│  • Waits for window.Pi to load                                      │
│  • Stores status in unified store                                   │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 2: MERCHANT CLICKS "CONNECT WALLET"                            │
│  • /app/page.tsx: handleConnectWallet()                             │
│  • Calls authenticateMerchant()                                     │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 3: PI WALLET AUTHENTICATION                                    │
│  • /lib/pi-sdk.ts: authenticateMerchant()                           │
│  • Calls window.Pi.authenticate(["username", "payments"])           │
│  • User approves in Pi Browser                                      │
│  • Pi SDK returns: {                                                │
│      user: {                                                        │
│        username: "@merchant",                                       │
│        address: "pi_wallet_address",  ← KEY                        │
│        walletAddress: "...",          ← KEY                        │
│        pi_address: "..."              ← KEY                        │
│      }                                                              │
│    }                                                                │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 4: AUTOMATIC WALLET ADDRESS EXTRACTION                         │
│  • /lib/pi-sdk.ts: authenticateMerchant()                           │
│  • Extracts wallet address:                                         │
│    const walletAddress =                                            │
│      authResult.user.address ||                                    │
│      authResult.user.walletAddress ||                              │
│      authResult.user.pi_address                                    │
│                                                                     │
│  • Logs: "Wallet address extracted: 0x..."                         │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 5: AUTOMATIC STORAGE IN UNIFIED STORE                          │
│  • /lib/unified-store.ts: completeMerchantSetup()                  │
│  • Stores:                                                          │
│    merchant: {                                                      │
│      isSetupComplete: true,                                         │
│      piUsername: "@merchant",                                       │
│      walletAddress: "0x...",  ← STORED AUTOMATICALLY               │
│      connectedAt: Date                                              │
│    }                                                                │
│  • Persists to localStorage                                         │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 6: USER FEEDBACK                                               │
│  • /app/page.tsx: handleConnectWallet()                             │
│  • Shows toast: "Wallet Connected • Ready to receive payments"      │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 7: MERCHANT CREATES PAYMENT                                    │
│  • Enters amount (e.g., 0.50)                                       │
│  • Clicks "Generate QR"                                             │
│  • /lib/operations.ts: createPayment()                              │
│  • Automatically reads from store:                                  │
│    const merchantAddress =                                          │
│      unifiedStore.state.merchant.walletAddress || ""                │
│                                                                     │
│  • Sends to API: {                                                  │
│      amount: 0.50,                                                  │
│      merchantId: "...",                                             │
│      merchantAddress: "0x..."  ← AUTOMATIC                         │
│    }                                                                │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 8: PAYMENT STORAGE                                             │
│  • /app/api/payments/route.ts                                       │
│  • Stores payment with wallet address:                              │
│    {                                                                │
│      id: "payment_123",                                             │
│      merchantId: "...",                                             │
│      merchantAddress: "0x...",  ← STORED WITH PAYMENT              │
│      amount: 0.50,                                                  │
│      status: "PENDING"                                              │
│    }                                                                │
│  • Persists to Redis                                                │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 9: QR CODE GENERATION                                          │
│  • QR code created with payment link                                │
│  • QR displays immediately (wallet address was automatic)           │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 10: CUSTOMER PAYMENT                                           │
│  • Customer scans QR with another Pi Wallet                         │
│  • Opens payment flow                                               │
│  • Approves payment in Pi Wallet                                    │
│  • Completes payment                                                │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 11: PAYMENT COMPLETION WEBHOOK                                 │
│  • /app/api/pi/complete/route.ts                                    │
│  • Receives payment completion                                      │
│  • Retrieves payment from store                                     │
│  • Extracts merchant wallet address:                                │
│    const merchantAddressForTransfer =                               │
│      existingPayment.merchantAddress ||                             │
│      existingPayment.from_address                                   │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 12: AUTOMATIC FUND TRANSFER                                    │
│  • /lib/transfer-service.ts: initiateTransfer()                     │
│  • Validates merchant address exists                                │
│  • Calls Pi API to transfer funds:                                  │
│    POST https://api.minepi.com/v2/payments                          │
│    {                                                                │
│      paymentId: "...",                                              │
│      toAddress: "0x...",  ← FROM STORED MERCHANT ADDRESS           │
│      amount: 0.50,                                                  │
│      txId: "..."                                                    │
│    }                                                                │
│  • Non-blocking (fire-and-forget)                                   │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 13: TRANSFER STATUS UPDATE                                     │
│  • Background job processes transfers                               │
│  • Checks status every 5 minutes                                    │
│  • Updates transfer record in database:                             │
│    {                                                                │
│      id: "transfer_123",                                            │
│      status: "COMPLETED",  ← UPDATED AUTOMATICALLY                 │
│      pi_transfer_id: "...",                                         │
│      completed_at: Date                                             │
│    }                                                                │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 14: MERCHANT NOTIFICATION                                      │
│  • In-app notification sent: "Transfer Completed"                   │
│  • Sound alert plays                                                │
│  • Dashboard updated with transfer status                           │
│  • Funds confirmed in merchant Pi Wallet                            │
└─────────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════

SUMMARY: AUTOMATIC FLOW (NO MANUAL ENTRY)

Connect Wallet → Address Automatically Captured
              → Stored in Unified Store
              → Used in Payment Creation
              → Used in Fund Transfer
              → Done

═══════════════════════════════════════════════════════════════════════

KEY POINTS:

✓ Wallet address extracted from Pi SDK automatically
✓ Stored in unified store automatically
✓ Passed to payments automatically
✓ Included in transfers automatically
✓ No manual configuration needed
✓ No Profile page entry needed
✓ Completely transparent to merchant

═══════════════════════════════════════════════════════════════════════
