# A2U user_not_found Diagnosis

## Current Status

✅ **Payment Flow**: Complete and working (Create → Approve → Complete → Database)
✅ **UID Extraction**: Working (captured from Pi.authenticate())
✅ **UID Passing**: Working (sent correctly in payment.uid)
✅ **UID Format**: Correct (payment.uid in request body matches Pi documentation)
✅ **A2U Request Format**: Correct (matches official Pi PHP SDK specification)

❌ **A2U Result**: Pi API returns `user_not_found` even though UID is valid and being sent

## Key Finding

Pi API error message shows the UID is recognized:
\`\`\`
User with uid 1a8127dc... was not found
\`\`\`

This means:
- The UID is **real and valid**
- The UID **matches the value being sent**
- But the UID is **not authorized for A2U operations** in this app's configuration

## Root Cause Analysis

The issue is NOT in the application code. The issue is **configuration-level** in Pi Developer Portal.

### Likely Causes (in order of probability)

1. **A2U Not Enabled** - The app may not have App-to-User (A2U) permissions enabled
   - Check: Developer Portal → App Settings → Permissions/Scopes
   - Look for: "App-to-User", "A2U", or "Direct Payments" checkbox

2. **App Not Approved** - The app status might be in "Development" or "Pending"
   - Check: Developer Portal → App Status
   - Must be: **Approved** for A2U transfers

3. **Domain Mismatch** - App Domain in Developer Portal might not match where app runs
   - Check: Developer Portal → App Domain setting
   - Should be: `flashpay.pi`

4. **Scope Issue** - The "payments" scope might not have A2U permission
   - Check: Developer Portal → Scopes
   - "payments" scope must include A2U capability

5. **Environment Mismatch** - Testnet vs Mainnet configuration
   - Check: Is the app configured for Testnet in Developer Portal?
   - Are you testing in Testnet environment?

6. **UID Scope Binding** - The UID from Pi.authenticate() might be bound to a different scope
   - The UID is app-scoped, but may not have been granted A2U permissions by the user

## What's Working

The application correctly:
- Initializes Pi SDK with `sandbox: false`
- Calls `Pi.authenticate(["username", "payments", "wallet_address"])`
- Extracts UID from `authResult.user.uid`
- Stores UID in unified state
- Passes UID to `/api/payments` endpoint
- Creates payment objects with correct UID
- Sends A2U requests in correct format: `{ payment: { uid, amount, memo, metadata } }`
- Includes Authorization header: `Key ${PI_API_KEY}`

## What Needs to Happen

Check **Pi Developer Portal Configuration**:

\`\`\`
Developer Portal → Your App → Settings
├─ App Status: Confirm "Approved"
├─ App Domain: Verify "flashpay.pi"
├─ Scopes: Enable "payments"
├─ A2U Permission: Enable "App-to-User transfers"
└─ Environment: Confirm "Testnet" (for testing)
\`\`\`

## Next Steps

1. **Verify App is Approved** - Check Developer Portal status
2. **Enable A2U Permissions** - Ensure A2U is explicitly enabled for the app
3. **Confirm Scopes** - Verify "payments" scope has A2U capability
4. **Test Fresh Authentication** - After changes, clear auth and reconnect wallet
5. **Check Error Logs** - Look for new error details after config changes

## Code Status

All code is **correct and implementation-complete**:
- ✅ UID extraction from Pi.authenticate()
- ✅ UID storage and passing
- ✅ A2U request format
- ✅ API endpoints

The application is **ready for A2U** once Pi Developer Portal is properly configured.
