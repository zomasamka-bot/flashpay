# FlashPay Error Quick Reference

## Case 1: "Pi wallet not responding" (Domain Mismatch)

### Symptom
When opening from Developer Portal:
```
Connection Failed – Pi wallet not responding
App Domain is set to flashpay0734.pi
```

### Root Cause
- App opened via external URL (e.g., `flashpay-two.vercel.app`)
- Domain doesn't match registered Pi domain

### ✅ Solution
**Access via registered domain only:**
```
✅ https://flashpay0734.pi (PiNet subdomain - CORRECT)
✅ https://flashpay.pi (when owned)
❌ https://flashpay-two.vercel.app (WRONG)
❌ Any other domain
```

### Quick Fix
1. Close the app
2. Open Pi Browser
3. Navigate to: `https://flashpay0734.pi`
4. DO NOT use the Vercel URL

---

## Case 2: "Cannot create a payment without 'payments' scope"

### Symptom
When clicking Pay in Pi Browser:
```
✅ Wallet connects successfully
❌ Payment Failed – Cannot create a payment without 'payments' scope
```

### Root Cause
- Wallet connection succeeded (domain is correct)
- But `payments` scope not enabled/granted

### ✅ Solution

#### Step 1: Enable Scope in Developer Portal
1. Go to https://develop.pi
2. Select FlashPay app
3. Navigate to **Scopes** section
4. **Enable**: ✅ `payments`
5. Save changes

#### Step 2: Clear App Data
1. Open Pi Browser
2. Go to Settings → Apps → FlashPay
3. Click "Clear Data"
4. Close Pi Browser completely

#### Step 3: Re-authenticate
1. Reopen Pi Browser
2. Navigate to `https://flashpay0734.pi`
3. Authenticate when prompted
4. **Approve** when asked for `payments` scope
5. Try payment again

---

## Quick Diagnostics

### Check Current Domain
Open browser console (F12):
```javascript
console.log("Current:", window.location.hostname)
console.log("Expected:", "flashpay0734.pi")
```

### Check SDK Status
```javascript
console.log("SDK:", !!window.Pi)
console.log("Authenticated:", !!window.Pi?.authenticate)
```

### Visit Diagnostics Page
Navigate to: `/diagnostics` in the app
- Shows detailed status of domain and scopes
- Identifies which error case you're experiencing

---

## Developer Portal Checklist

Before testing, ensure:
- [ ] App domain: `flashpay0734.pi`
- [ ] Scopes enabled: `payments` ✅
- [ ] App status: "Approved" or "Development"
- [ ] Using Pi Browser (not Chrome/Safari)
- [ ] Accessing via: `https://flashpay0734.pi`

---

## Error Matrix

| Error | Wallet Connects? | Payment Fails? | Cause | Fix |
|-------|------------------|----------------|-------|-----|
| Case 1 | ❌ No | N/A | Domain mismatch | Use `flashpay0734.pi` |
| Case 2 | ✅ Yes | ❌ Yes | Missing scope | Enable `payments` scope |

---

## Still Having Issues?

1. **Check Diagnostics**: Visit `/diagnostics` page
2. **Check Console**: Open browser console for detailed logs
3. **Verify Domain**: Must exactly match `flashpay0734.pi`
4. **Clear Cache**: Clear Pi Browser app data
5. **Check Portal**: Verify all settings in Pi Developer Portal

## Support Resources

- **Diagnostics**: `/diagnostics` (in app)
- **Full Guide**: See `PI_DOMAIN_AND_SCOPE_DEBUG.md`
- **Pi Developer Portal**: https://develop.pi
- **Pi Docs**: https://developers.minepi.com
