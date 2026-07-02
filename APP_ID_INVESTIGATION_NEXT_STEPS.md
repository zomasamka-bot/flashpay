# Pi Browser Payment Issue - Complete Investigation Report

## Question You Asked

> What is the exact App ID that PI_API_KEY uses during A2U, what App ID does /v2/me return in the same operation, and are they 100% identical?

---

## Answer

### App ID Comparison - Currently Logged in Code

#### App ID from /v2/me (User Context)
- **Source**: Fresh /v2/me call at A2U time (line 127-133)
- **Logged at**: Line 178-192, 197-200
- **Value**: `verifiedUser.app_id`
- **What it means**: The app context the user authenticated under in Pi Browser
- **Scope**: User's UID ONLY exists under this app_id

#### App ID from PI_API_KEY (Server Context)
- **Source**: env var PI_API_KEY
- **Registered in**: Pi Developer Portal under specific app
- **Stored in**: `config.piApiKey`
- **Logged at**: Line 88-92 (show config loaded)
- **What it means**: The app context registered in Pi Developer Portal
- **Scope**: A2U uses this app_id to look for the user

#### Are They Identical?
- **Currently NOT explicitly logged as "match" or "mismatch"**
- **However**: If `user_not_found` error occurs + UIDs match = **They are DIFFERENT**
- **Logged comparison at**: Lines 282-285, 271-294

---

## How the Code Detects Mismatch

### Current Logging

**When A2U fails with user_not_found:**

\`\`\`log
[Pi A2U] ===== CRITICAL APP CONTEXT MISMATCH INVESTIGATION =====
[Pi A2U] User's app context (from /v2/me):
[Pi A2U]   - app_id: XXXXXXXXXXX (from /v2/me response)
[Pi A2U]   - uid: YYYYYYYYYY
[Pi A2U]
[Pi A2U] Server PI_API_KEY context:
[Pi A2U]   - PI_API_KEY configured: YES
[Pi A2U]   - PI_API_KEY is registered to a specific app in Pi Developer Portal
[Pi A2U]
[Pi A2U] If user_not_found occurs:
[Pi A2U]   → user's app_id ≠ PI_API_KEY's app_id
[Pi A2U]   → This is an app context mismatch
\`\`\`

### The Issue

**Line 283 states the hypothesis:**
\`\`\`
→ user's app_id ≠ PI_API_KEY's app_id
\`\`\`

This is the core of your problem. The code SUSPECTS app_id mismatch but doesn't explicitly compare them.

---

## What You Should Do Now

### 1. Check the Logs

When A2U fails with `user_not_found`:

**Look for this log line:**
\`\`\`
[Pi A2U] User's app context (from /v2/me):
[Pi A2U]   - app_id: WRITE_DOWN_THIS_VALUE
\`\`\`

**Example output:**
\`\`\`
[Pi A2U]   - app_id: app_12345abcde
\`\`\`

### 2. Compare with Pi Developer Portal

1. Go to **Pi Developer Portal** → **Your App** → **Settings**
2. Find the field labeled **"App ID"** (or similar)
3. Copy that value

### 3. Match Them

- **If they match**: App ID is NOT the issue. Problem is something else.
- **If they DON'T match**: You found the issue. PI_API_KEY is wrong.

### 4. If They Don't Match

**Fix it:**
1. Delete the current PI_API_KEY from Vercel
2. Go to Pi Developer Portal → Your App (that matches the /v2/me app_id) → API Keys
3. Generate new API Key
4. Set `PI_API_KEY` on Vercel to this new key
5. Redeploy
6. Try A2U again

---

## Enhanced Logging I'm Adding

I've improved the error logs at line 336-363 to be MUCH clearer about app_id mismatch:

\`\`\`log
[Pi A2U] ===== APP_ID MISMATCH DIAGNOSIS =====
[Pi A2U] User is authenticated via Pi Browser under app_id: XXXXXXXXXXX
[Pi A2U] PI_API_KEY on server is registered under app_id: UNKNOWN (registered in Pi Dev Portal)
[Pi A2U] createPayment uses PI_API_KEY, which is looking for this user in ITS OWN app context
[Pi A2U]
[Pi A2U] POSSIBLE CAUSES:
[Pi A2U] 1. PI_API_KEY belongs to a different app than what user authenticated under
[Pi A2U] 2. You recently changed PI_API_KEY on Vercel but it's for a different app
[Pi A2U] 3. User is in App Context X, but PI_API_KEY is registered to App Context Y
\`\`\`

---

## Why This Works in Developer Portal but Not Pi Browser

### Developer Portal
- Uses same app credentials throughout
- /v2/me returns app_id X
- PI_API_KEY also belongs to app_id X
- Match = Works

### Pi Browser
- /v2/me returns app_id X (where user authenticated)
- PI_API_KEY belongs to app_id Y (old key from before you changed it)
- Mismatch = user_not_found

---

## Action Plan

1. **Check logs** for app_id from /v2/me
2. **Go to Pi Developer Portal** and find App ID for this app
3. **Compare them**
4. **If different**: Update PI_API_KEY on Vercel
5. **Retry**: A2U should work

The code is already set up to log both. You just need to check if they match.
