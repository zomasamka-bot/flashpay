# Debug Guide: Pi Browser App ID Mismatch Issue

## Quick Diagnosis Steps

### Step 1: Open Pi Browser Developer Console
\`\`\`
In Pi Browser: Menu → More Tools → Developer Console
\`\`\`

### Step 2: Trigger Authentication
1. Go to Create Payment page
2. Click "Connect Pi Wallet"
3. Complete authentication
4. Copy the logs from console

### Step 3: Find the Key Data Points

في الـ console logs ابحث عن هذا الـ section:
\`\`\`
[MERCHANT-AUTH] ===== APP CONTEXT FROM AUTHENTICATION =====
[MERCHANT-AUTH] authResult.user.app_id: <THIS IS THE VALUE>
[MERCHANT-AUTH] authResult.user.username: xxx
\`\`\`

**اكتب قيمة `app_id` هنا:**
\`\`\`
App ID from Pi Browser authentication: _______________
\`\`\`

### Step 4: Get Your Developer Portal App ID

1. اذهب إلى https://developers.minepi.com/
2. اختر تطبيقك (FlashPay)
3. اذهب إلى Settings/App Settings
4. ابحث عن "App ID" أو "Application ID"

**اكتب قيمة App ID من Portal هنا:**
\`\`\`
App ID from Pi Developer Portal: _______________
\`\`\`

### Step 5: Compare the Values

\`\`\`
Pi Browser app_id:  [من Step 3]
Developer Portal:   [من Step 4]

هل متطابقة؟ ☐ YES ☐ NO
\`\`\`

## إذا كانت مختلفة (App IDs don't match)

### السبب المحتمل:
**Pi Browser قد تستخدم cached session من API Key القديم**

### الحل:
1. **في Pi Browser:**
   - Open Settings
   - Select "Clear Cache" أو "Clear Storage"
   - اختر "Clear All"

2. **أعد تحميل التطبيق:**
   - Close and reopen the app
   - Click "Connect Pi Wallet" again
   - Authenticate again

3. **حاول الدفع من جديد**

4. **إذا استمرت المشكلة:**

### الحل الشامل (Nuclear Option):

1. اذهب إلى Pi Developer Portal
2. في App Settings، ابحث عن "API Keys"
3. تأكد من أن الـ API Key المستخدم:
   \`\`\`
   - يطابق الـ app_id الذي يظهر في authenticated response
   - OR: اعمل API Key جديدة من نفس app_id
   \`\`\`

4. على Vercel:
   \`\`\`
   Settings → Environment Variables
   PI_API_KEY = <الـ API Key الصحيح>
   \`\`\`

5. Redeploy التطبيق:
   \`\`\`
   vercel deploy --prod
   \`\`\`

6. في Pi Browser:
   \`\`\`
   Clear All Cache/Storage
   Refresh the app
   Authenticate again
   Try payment
   \`\`\`

## إذا كانت متطابقة (App IDs match)

إذا كان App ID من Pi Browser يطابق Developer Portal، لكن A2U لا يزال يفشل:

### ابحث عن logs مختلفة:

عند الدفع، في backend logs ابحث عن:
\`\`\`
[Pi A2U] ===== CRITICAL: APP CONTEXT MISMATCH INVESTIGATION =====
[Pi A2U] User's app context (from /v2/me):
[Pi A2U]   - app_id: <SHOULD MATCH YOUR PORTAL>
[Pi A2U] If user_not_found occurs:
[Pi A2U]   → user's app_id ≠ PI_API_KEY's app_id
\`\`\`

### إذا كانت المشكلة في الـ API Key نفسها:

تحقق من:
1. هل `PI_API_KEY` صحيح؟ (copy-paste correctly)
2. هل الـ app مفعل في Developer Portal؟
3. هل A2U enabled في الـ app settings؟
4. هل هناك typo في الـ API Key على Vercel؟

## Key Environment Variables to Verify

\`\`\`
NEXT_PUBLIC_APP_URL
→ يجب أن يكون Vercel domain فقط (flashpay-two.vercel.app)
→ لا يجب أن يكون custom domain إذا كان flashpay0734.pinet.com

PI_API_KEY  
→ من Pi Developer Portal (app settings → API Keys)
→ يجب أن يكون صحيح بدون spaces/typos

DATABASE_URL, UPSTASH_REDIS_REST_URL, etc.
→ يجب أن تكون صحيحة
\`\`\`

## Common Issues and Fixes

| Issue | Symptom | Fix |
|-------|---------|-----|
| Old cached session | U2A ✅, A2U ❌ | Clear cache in Pi Browser |
| Wrong API Key | user_not_found in A2U | Update PI_API_KEY on Vercel |
| App not enabled | A2U fails | Enable A2U in Developer Portal app settings |
| Different app context | App ID mismatch | Regenerate API Key for correct app |
| Incomplete redeploy | Some instances fail | Full redeploy on Vercel |

## Still Having Issues?

1. **Collect these logs:**
   \`\`\`
   [MERCHANT-AUTH] full authentication response
   [Pi A2U] full /v2/me response
   [Pi A2U] app context investigation section
   [Pi A2U] error response from Pi API
   \`\`\`

2. **Verify:**
   - Pi Developer Portal app_id value
   - PI_API_KEY first 8 chars (to identify which app it's from)
   - Current NEXT_PUBLIC_APP_URL

3. **Try:**
   - Different browser/device
   - Different network (mobile hotspot vs WiFi)
   - Fresh Pi Browser reinstall
