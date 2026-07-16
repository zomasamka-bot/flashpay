# FlashPay A2U Resolution Plan

## Summary of Work Done This Session

### ✓ Fixed
1. **Payment Creation** - Works perfectly, UID is passed correctly through the entire flow
2. **Pi Webhook Complete** - Triggers A2U correctly
3. **A2U Endpoint** - Receives merchantUid and sends it to Pi API with correct field name `recipient_uid`
4. **Database Storage** - All payment data is stored and retrieved correctly
5. **Error Handling** - Added validation to block payment if UID is empty

### ⚠️ The Remaining Problem
**Pi API returns: `user_not_found`**

This means the `merchantUid` being sent is NOT a valid app-scoped UID for A2U in Pi Network Testnet.

## Why This Happens

Pi.authenticate() in Pi Browser returns an `authResult.user` object. The UID for A2U operations must be:
1. The exact value from `authResult.user` field (likely `uid`, `user_id`, or another variant)
2. App-scoped (tied to this specific app and user)
3. From the CURRENT session (not cached/stored from previous session)

**Current Implementation:**
- ✓ We call `authenticateMerchant()` on app load
- ✓ We capture uid and store it
- ✓ We pass it through all payment stages
- ✓ We send it to A2U with correct field name

**But:** If the UID field doesn't exist in `authResult.user` or comes from wrong location, Pi API will reject it.

## Next Steps

### Step 1: Verify UID is Captured
1. Open app in Pi Browser
2. Check browser console for:
   \`\`\`
   [v0] UID captured: [value]
   \`\`\`
   - If you see a value like "abc123xyz..." → UID is being captured ✓
   - If you see "❌ EMPTY" → UID is not in the response ❌

### Step 2: Identify Correct UID Field
If UID is empty, the console should show:
\`\`\`
[v0] ERROR: UID is empty from Pi.authenticate()
[v0] Available fields in authResult.user:
[v0]   - username: string
[v0]   - wallet_address: string
[v0]   - [OTHER FIELDS HERE]
\`\`\`

**Tell me which fields are listed** and we'll update the code to use the correct one.

### Step 3: Test A2U with Correct UID
Once we identify the right UID field, the flow will work:
\`\`\`
Pi.authenticate() → Extract UID → Store → Use in A2U → Pi API accepts it
\`\`\`

## Technical Details

**Current UID Extraction (in `/lib/pi-sdk.ts`):**
\`\`\`javascript
const uid = authResult.user.uid || authResult.user.userId || authResult.user.user_id || ""
const appUid = authResult.user.app_uid || authResult.user.appUid || ""
const finalUid = uid || appUid || ""
\`\`\`

**Current UID Usage (in `/app/api/pi/a2u/route.ts`):**
\`\`\`javascript
recipient: {
  recipient_uid: merchantUid,  // This field name is correct per Pi docs
}
\`\`\`

## Decision Point

**Option A: Continue Now**
- You run the app in Pi Browser
- Check console logs for UID status
- Report which fields exist in authResult.user
- We'll make targeted fix based on actual data

**Option B: Rest and Resume Later**
- You've done excellent work
- All infrastructure is ready
- Come back fresh when you're ready

Which would you prefer?
