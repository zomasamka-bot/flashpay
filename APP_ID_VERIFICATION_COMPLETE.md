# App ID Verification - Complete Analysis

## Direct Answer to Your Question

### What App IDs are being compared?

**1. App ID from /v2/me (User Context in Pi Browser)**
\`\`\`
Source: Fresh /v2/me call at A2U time
Variable: verifiedUser.app_id
Log Line: 178, 189, 198
\`\`\`

**2. App ID from PI_API_KEY (Server Context for A2U)**
\`\`\`
Source: env var PI_API_KEY 
Registered in: Pi Developer Portal under specific app
Location: config.piApiKey
Log Line: 88-92, 278-279
\`\`\`

### Where are they compared?

**Logs show App ID verification at lines 196-200 in /app/api/pi/a2u/route.ts:**

\`\`\`typescript
console.log("[Pi A2U] ===== APP_ID VERIFICATION =====")
const meAppId = verifiedUser.app_id
console.log("[Pi A2U] app_id from /v2/me:", meAppId || "NOT PROVIDED")
console.log("[Pi A2U] NOTE: The app_id must match the app registered in Pi Developer Portal")
console.log("[Pi A2U] NOTE: PI_API_KEY must belong to the same app_id"
\`\`\`

**And then at lines 277-283 for error diagnosis:**

\`\`\`typescript
console.log("[Pi A2U] Server PI_API_KEY context:")
console.log("[Pi A2U]   - PI_API_KEY configured:", config.piApiKey ? "YES" : "NO")
console.log("[Pi A2U]   - PI_API_KEY is registered to a specific app in Pi Developer Portal")
console.log("[Pi A2U] [User Context:]")
console.log("[Pi A2U]   → user's app_id ≠ PI_API_KEY's app_id
\`\`\`

---

## The Issue

### What happens:

1. **/v2/me call succeeds** → Returns user data with `app_id`
   - This is the app the user authenticated under in Pi Browser
   - This `app_id` is scoped to the Pi Browser session

2. **createPayment call fails with user_not_found**
   - Uses `Key ${config.piApiKey}` header
   - This PI_API_KEY is registered to a DIFFERENT app in Pi Developer Portal
   - Pi API sees: "User authenticated under App X, but this API key belongs to App Y"
   - Result: `user_not_found` because the UID doesn't exist in App Y's context

### Why it works in Developer Portal:

- In Developer Portal, you likely use the SAME app credentials that match PI_API_KEY
- Both /v2/me and createPayment use same app context
- No mismatch = user is found

### Why it fails in Pi Browser:

- App may be loaded under different app registration
- OR Pi Browser cached old app context from previous PI_API_KEY
- /v2/me returns user from App X
- createPayment (PI_API_KEY) looks in App Y
- Mismatch = `user_not_found`

---

## How to Debug This

The A2U route ALREADY logs the app_id from /v2/me. You should see:

**In Vercel logs, look for:**
\`\`\`
[Pi A2U] app_id from /v2/me: <SOME_APP_ID>
\`\`\`

Then compare this with:

**Your Pi Developer Portal:**
- Settings → App ID
- This should match what /v2/me returned

**If they don't match:**
- You changed PI_API_KEY recently
- The new PI_API_KEY is registered to a different app
- Solution: Update PI_API_KEY on Vercel to match the app that Pi Browser is using

**If they DO match:**
- Look at the next error logs
- The issue is not app_id mismatch
- Could be: permissions, A2U not enabled on this app, or something else

---

## Action Items

1. **Check Vercel logs** for this line:
   \`\`\`
   [Pi A2U] app_id from /v2/me: XXXXXXXXX
   \`\`\`

2. **Go to Pi Developer Portal → Your App → Settings**
   - Find the "App ID" field
   - Compare with the logged value

3. **If they differ:**
   - The PI_API_KEY you set is wrong
   - Get correct PI_API_KEY for the matching app
   - Update on Vercel

4. **If they match:**
   - App ID is NOT the issue
   - Problem is something else
   - Check the error message more carefully
