# CRITICAL ROOT CAUSE FOUND: App ID Mismatch Between Environments

## The Evidence

You've discovered something critical:

**Developer Portal (WORKING):**
- app_id: `695ecb29ed46b43b6ec573cb`
- uid: `ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa`
- Result: U2A ✅ + A2U ✅ + Settlement ✅

**Pi Browser (FAILING):**
- app_id: `695d44a6227530960816f8c6`
- uid: `1a8127dc-34a2-442b-a58a-f12a78fe07c2`
- Result: U2A ✅ + A2U ❌ (user_not_found)

## Why Are App IDs Different?

Same server, same PI_API_KEY, **but /v2/me returns different app_id values**.

This means:
- **Developer Portal** loads the app under one app context
- **Pi Browser** loads the app under a DIFFERENT app context
- These are **two completely separate app registrations in Pi Network**

## Why Does A2U Fail Only?

1. **U2A (User→App)** - Works because:
   - It's a direct transfer within the same app context
   - User's wallet → App wallet (both in same app context)
   - No cross-context verification needed

2. **A2U (App→User)** - Fails because:
   - `createPayment` endpoint requires:
     - A valid user UID
     - PLUS verification that this UID exists in the app context registered under PI_API_KEY
   - The UID exists (in Pi Network globally)
   - But NOT in the app context that your PI_API_KEY is registered to
   - Result: `user_not_found` (in THIS app's context)

## The Real Problem

**PI_API_KEY is registered to app_id: `695ecb29ed46b43b6ec573cb`**

But when user loads from Pi Browser, they authenticate under a DIFFERENT app_id: `695d44a6227530960816f8c6`

So:
```
User: "I'm uid=1a8127dc under app_id=695d44a6227530960816f8c6"
PI_API_KEY: "I'm looking for users under app_id=695ecb29ed46b43b6ec573cb"
Result: user_not_found ❌
```

## How This Happens

This occurs when:
1. FlashPay app registered as TWO different apps in Pi Developer Portal
2. One app for Developer Portal testing (app_id: `695ecb29ed46b43b6ec573cb`)
3. One app for Pi Browser/Testnet (app_id: `695d44a6227530960816f8c6`)
4. OR Pi Browser automatically creates separate app context for security
5. You have PI_API_KEY from the FIRST app, not the SECOND

## Confirmation

Run A2U again from Pi Browser and check Vercel logs:
```
[Pi A2U] app_id from /v2/me: 695d44a6227530960816f8c6
[Pi A2U] payment.uid: 1a8127dc-34a2-442b-a58a-f12a78fe07c2
[Pi A2U] ❌ user_not_found
```

Then compare with Developer Portal logs:
```
[Pi A2U] app_id from /v2/me: 695ecb29ed46b43b6ec573cb
[Pi A2U] payment.uid: ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa
[Pi A2U] ✅ A2U SUCCESS
```

## Solution

You need to determine:
1. Which app_id does your PI_API_KEY belong to?
2. Get the correct PI_API_KEY for the app_id that Pi Browser uses: `695d44a6227530960816f8c6`
3. Update PI_API_KEY on Vercel

OR

1. Ensure Pi Browser loads the same app context as Developer Portal (app_id: `695ecb29ed46b43b6ec573cb`)
