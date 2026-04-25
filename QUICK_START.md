# QUICK START: Test the Transfer System in 5 Minutes

## Prerequisites
- Vercel account with FlashPay deployed
- Pi Browser with Testnet wallet
- Test Pi (available in Testnet)

## Step 1: Set Environment Variables (2 min)
```
Go to Vercel Dashboard
→ Select FlashPay project
→ Settings → Environment Variables

Add these (minimum required):
- PI_API_KEY: [your Pi API key from https://developers.minepi.com]
- PI_TESTNET_WALLET_ADDRESS: [your Testnet wallet address from Pi Wallet]
- DATABASE_URL: [your PostgreSQL connection string]
- UPSTASH_REDIS_REST_URL: [your Redis URL]
- UPSTASH_REDIS_REST_TOKEN: [your Redis token]

Click Deploy to apply changes
```

## Step 2: Deploy (automatic after env vars)
Vercel auto-deploys. Wait for deployment to complete.

Check deployment status: Vercel Dashboard → Deployments → Check for green checkmark

## Step 3: Test Payment Flow (1 min)
1. Open FlashPay in Pi Browser
2. Click "Create Payment"
3. Enter: 0.1 Pi
4. Click "Generate Payment Link"
5. Click "Pay Now"
6. Complete payment in Pi Wallet
7. Verify payment history shows payment

## Step 4: Test Transfer (1 min)
1. From Profile page, click "Fund Transfers"
2. You should see your transfer appear within 5 seconds
3. Status should show "Processing" or "Completed"
4. If you hear a sound, notifications are working!

## Step 5: Test Dashboard Features (1 min)
1. Click "Refresh" button
2. Verify statistics update:
   - Total Transferred (shows π amount)
   - Success Rate (shows percentage)
3. Click "Export CSV" to download transfer history
4. Verify CSV file opens correctly

## Done! 🎉

If everything works, your system is ready for:
- Full Testnet testing (run all 8 tests in DEPLOYMENT_GUIDE.md)
- Domain approval
- Mainnet release

## Troubleshooting

### Transfers not appearing?
- Check Vercel logs: Vercel Dashboard → Logs
- Ensure DATABASE_URL is set
- Ensure PI_API_KEY is set
- Hard refresh dashboard (Ctrl+F5)

### No sound notification?
- Check browser volume
- Check browser notification permissions
- Open browser console (F12) for errors

### Export not working?
- Try different browser
- Clear browser cache
- Check database has transfers

### Dashboard stuck loading?
- Hard refresh (Ctrl+F5)
- Check for JavaScript errors (F12 → Console)
- Verify merchantId in localStorage

## Next Steps

1. **Run Full Test Suite**
   - See DEPLOYMENT_GUIDE.md → PART 5 for all 8 tests

2. **Monitor Testnet**
   - Watch Vercel logs for 24 hours
   - Test multiple payments
   - Verify auto-retry works

3. **Switch to Mainnet**
   - See DEPLOYMENT_GUIDE.md → PART 7 when ready

---

Total Setup Time: ~15 minutes
Total Test Time: ~5 minutes
Status: Ready for Production
