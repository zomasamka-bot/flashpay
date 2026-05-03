# 🔧 Quick Fix Reference

## Your System is BLOCKED by Stuck Payments ❌

### FIX IT IN 30 SECONDS:

**Option 1: Use the UI (Easiest)**
1. Open app → click "System Diagnostics" (bottom of home)
2. Find "Payment System Status & Recovery" section  
3. Click red button: "Clear Stuck Payments & Reset"
4. Confirm → ✅ DONE! System restored

**Option 2: Direct API Call**
\`\`\`bash
curl -X POST https://your-app-url/api/reset/payments
\`\`\`

**Option 3: Command Line**
\`\`\`bash
node scripts/reset-payments.mjs
\`\`\`

---

## What This Does

✅ Clears all stuck pending payments from Redis  
✅ Restores Pi Network payment flow  
✅ System accepts new payments again  
✅ Preserves completed/paid payments  

---

## What Happens Next

1. **System immediately recovers** - no code changes needed
2. **New payments work** - create and scan QR codes normally  
3. **Full flow restored** - merchants can accept payments

---

## Files You Need to Know

📄 `/PAYMENT_SYSTEM_FIX.md` - Full technical documentation  
📄 `/PAYMENT_RESET_GUIDE.md` - Complete user guide  
🔧 `/app/api/reset/payments/route.ts` - Reset endpoint  
🎨 `/components/payment-reset-panel.tsx` - Reset UI  
📱 `/app/diagnostics/page.tsx` - Contains reset panel  

---

## Verify It Worked

✓ Check Diagnostics page - all counts should be 0 or healthy  
✓ Try creating a test payment (0.1 π)  
✓ Create should work without "pending payment" error  
✓ QR code generation should work  
✓ Full payment flow should work  

---

## If Something Goes Wrong

- Reset is safe and reversible
- Only affects stuck pending payments
- Your code stays unchanged
- Can run reset multiple times
- Check `/PAYMENT_RESET_GUIDE.md` troubleshooting section

---

**Status:** System equipped with emergency recovery  
**Next Action:** Use the UI reset or API to clear stuck payments  
**Support:** Read the full documentation files for details
