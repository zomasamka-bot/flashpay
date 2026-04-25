# QR Flow - Quick Reference

## What's Fixed
- QR code now opens inside Pi Browser (not external browser)
- Uses: `pi://flashpay.pi/pay/{id}` instead of Vercel domain

## What May Still Be Broken
- "Payment Not Found" when customer scans QR immediately
- Likely timing issue: Redis commit takes ~500ms, customer scans before it's done

## Quick Test
1. Merchant: Create payment, wait 3-5 seconds
2. Customer: Scan QR (should open in Pi Browser)
3. Customer: Should see payment details OR see it loading

## If "Payment Not Found"
Check console logs:
- Merchant: Look for `[API] ✅ Redis.set() completed`
- Customer: Look for retry attempts `[v0] Attempt`

If logs show Redis stored it, but customer still fails = timing issue

## Solution
1. Wait longer before scanning (3-5 seconds)
2. Or check Redis configuration
3. Or increase retry logic in customer page

## Testing Steps
See `/QR_FLOW_COMPLETE_ANALYSIS.md` for full testing protocol
See `/QR_FLOW_DEBUG_GUIDE.md` for debugging steps
