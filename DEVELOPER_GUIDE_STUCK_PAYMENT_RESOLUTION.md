# Stuck Payment Resolution Guide for Pi Network Apps
## Technical Documentation for Developers

---

## Problem Statement

When a payment gets stuck on Pi Network during activation or transaction flow, the Pi SDK throws:
```
"A pending payment needs to be handled"
```

This error **blocks all new payments** and prevents the app from functioning until the stuck payment is cleared.

### Root Cause

Pi Network's `authenticate()` function checks for incomplete/stuck payments on Pi's servers. If one exists:
1. Pi SDK calls `onIncompletePaymentFound(payment)` callback
2. If the callback doesn't properly handle the payment, Pi throws an error
3. The error blocks authentication, which blocks the entire payment flow
4. No new payments can be created until this stuck payment is resolved

---

## Immediate Fix (Quick Recovery)

### Step 1: Detect the Error
Your app will show: `"A pending payment needs to be handled"`

### Step 2: Clear from Local Storage/Redis
Stuck payments are stored in Redis/local store with key: `payment:*`

**Using API call:**
```bash
curl -X POST https://your-app-url/api/emergency/clear-stuck-payment
```

**Expected Response:**
```json
{
  "success": true,
  "cleared": ["payment_id_1", "payment_id_2"],
  "message": "Stuck payments cleared"
}
```

### Step 3: Test Payment Flow
1. Refresh the app
2. Try creating a new payment
3. Payment flow should work normally

---

## Root Cause Fix (Prevent Future Issues)

This is the **critical code change** needed in your Pi SDK authentication:

### File: `lib/pi-sdk.ts` (or equivalent)

**BEFORE (Broken):**
```typescript
export const authenticateCustomer = async () => {
  const authResult = await window.Pi.authenticate(
    ["payments"],
    (payment) => {
      console.log("Incomplete payment:", payment)
      // ❌ PROBLEM: Just logs and ignores - doesn't handle the payment
    }
  )
}
```

**AFTER (Fixed):**
```typescript
export const authenticateCustomer = async () => {
  try {
    const authResult = await window.Pi.authenticate(
      ["payments"],
      async (payment) => {
        // ✅ SOLUTION: Actually handle the incomplete payment
        console.log("[Pi] Incomplete payment found:", payment)
        
        if (payment && payment.identifier) {
          try {
            // Send to backend completion endpoint
            const response = await fetch("/api/pi/complete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payment),
            })
            
            if (response.ok) {
              console.log("[Pi] Completed incomplete payment:", payment.identifier)
            }
          } catch (error) {
            console.error("[Pi] Error completing payment:", error)
          }
        }
      }
    )
    
    return { success: true }
  } catch (error) {
    const isStuckPayment = error instanceof Error && 
      error.message.includes("pending payment")
    
    // ✅ SOLUTION: Catch stuck payment errors and clear them
    if (isStuckPayment) {
      console.warn("[Pi] Stuck payment detected - clearing...")
      try {
        await fetch("/api/emergency/clear-stuck-payment", { method: "POST" })
        return {
          success: false,
          error: "Stuck payment cleared. Please try again."
        }
      } catch (err) {
        console.error("[Pi] Failed to clear stuck payment", err)
      }
    }
    
    return { success: false, error: error.message }
  }
}
```

### Key Changes:
1. **Add async callback handler** - Don't just log the payment, process it
2. **Send to completion endpoint** - Forward stuck payment to `/api/pi/complete`
3. **Catch stuck payment errors** - Wrap authenticate in try/catch
4. **Detect error pattern** - Check for "pending payment" in error message
5. **Auto-clear stuck payments** - Call emergency endpoint on error

---

## Backend Implementation

### Required Endpoint: `POST /api/pi/complete`

This endpoint must handle stuck payments from Pi Network:

```typescript
// app/api/pi/complete/route.ts
export async function POST(request: NextRequest) {
  const paymentDTO = await request.json()
  
  // Extract payment ID (may come from metadata or be direct Pi payment)
  const paymentId = paymentDTO.metadata?.paymentId
  
  // If no paymentId, this is an incomplete payment from Pi - handle gracefully
  if (!paymentId) {
    console.warn("Incomplete payment without paymentId - skipping")
    return NextResponse.json({ 
      success: true, 
      message: "Incomplete payment acknowledged" 
    })
  }
  
  try {
    // Get transaction ID
    const txid = paymentDTO.transaction?.txid || paymentDTO.txid
    if (!txid) {
      return NextResponse.json(
        { error: "Missing transaction ID" }, 
        { status: 400 }
      )
    }
    
    // Complete with Pi API
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentDTO.identifier}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${process.env.PI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ txid }),
      }
    )
    
    // Mark payment as PAID in local store
    if (response.ok) {
      // Update Redis/database
      await redis.set(`payment:${paymentId}`, JSON.stringify({
        ...payment,
        status: "paid",
        paidAt: new Date().toISOString(),
        txid,
        piPaymentId: paymentDTO.identifier,
      }))
    }
    
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[Pi] Completion error:", error)
    return NextResponse.json(
      { error: "Failed to complete payment" }, 
      { status: 500 }
    )
  }
}
```

### Required Endpoint: `POST /api/emergency/clear-stuck-payment`

This endpoint clears stuck payments from Redis:

```typescript
// app/api/emergency/clear-stuck-payment/route.ts
export async function POST(request: NextRequest) {
  try {
    // Find all payments with "pending" or "processing" status
    const redis = createRedisClient()
    
    // Get all payment keys
    const keys = await redis.keys("payment:*")
    const cleared = []
    
    for (const key of keys) {
      const payment = JSON.parse(await redis.get(key))
      
      // Clear pending payments
      if (payment.status === "pending" || payment.status === "processing") {
        // Mark as cancelled (preserve audit trail)
        await redis.set(key, JSON.stringify({
          ...payment,
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
          reason: "Emergency clear - stuck payment",
        }))
        
        cleared.push(key)
      }
    }
    
    return NextResponse.json({
      success: true,
      cleared,
      message: `Cleared ${cleared.length} stuck payment(s)`
    })
  } catch (error) {
    console.error("[Emergency] Clear failed:", error)
    return NextResponse.json(
      { error: "Failed to clear stuck payments" }, 
      { status: 500 }
    )
  }
}
```

---

## Checklist for Complete Fix

**Frontend (Pi SDK Handling):**
- [ ] Add try/catch around `Pi.authenticate()`
- [ ] Detect "pending payment" error messages
- [ ] Auto-call `/api/emergency/clear-stuck-payment` on error
- [ ] Implement async `onIncompletePaymentFound` callback
- [ ] Forward incomplete payments to `/api/pi/complete`

**Backend (Payment Completion):**
- [ ] Implement `/api/pi/complete` endpoint
- [ ] Handle missing paymentId gracefully
- [ ] Extract txid from payment object
- [ ] Call Pi API to complete payment
- [ ] Update local payment status to "paid"

**Emergency Recovery:**
- [ ] Implement `/api/emergency/clear-stuck-payment` endpoint
- [ ] Mark stuck payments as "cancelled" (not deleted)
- [ ] Preserve audit trail with reason and timestamp

---

## Prevention Best Practices

### 1. Never Ignore Incomplete Payments
```typescript
// ❌ BAD - This causes stuck payments
Pi.authenticate(["payments"], (payment) => {
  console.log("Incomplete payment:", payment) // Just logging!
})

// ✅ GOOD - Actually process it
Pi.authenticate(["payments"], async (payment) => {
  await sendToBackendForCompletion(payment)
})
```

### 2. Always Complete Transactions
When Pi returns a payment object with a `txid`, always:
1. Send it to `/api/pi/complete`
2. Update local status to "paid"
3. Never leave it in "pending" state

### 3. Wrap Auth in Error Handler
```typescript
try {
  const result = await Pi.authenticate(["payments"], callback)
} catch (error) {
  // Stuck payments throw errors - MUST catch them
  if (error.message.includes("pending payment")) {
    await clearStuckPayments()
  }
}
```

### 4. Monitor Payment Status
Implement regular checks for stuck payments:
```typescript
// Run on app load and periodically
const checkForStuckPayments = async () => {
  const payments = await redis.keys("payment:*")
  for (const key of payments) {
    const payment = JSON.parse(await redis.get(key))
    
    // If pending for > 5 minutes, mark as failed/cancelled
    if (payment.status === "pending" && 
        Date.now() - new Date(payment.createdAt) > 5 * 60 * 1000) {
      await markAsCancelled(payment)
    }
  }
}
```

---

## Testing the Fix

### Test Case 1: Clear Existing Stuck Payment
```bash
# Verify stuck payment exists
curl https://your-app-url/api/emergency/clear-stuck-payment -X GET

# Clear it
curl https://your-app-url/api/emergency/clear-stuck-payment -X POST

# Verify it's cleared and status changed to "cancelled"
curl https://your-app-url/api/emergency/clear-stuck-payment -X GET
```

### Test Case 2: Verify Auth Error Handling
1. Create a payment (if possible)
2. Let it get stuck
3. App should automatically detect and clear
4. User sees: "Stuck payment cleared. Try again."
5. New payment creation should work

### Test Case 3: Verify Incomplete Payment Handling
1. Trigger a payment transaction
2. Verify `onIncompletePaymentFound` callback fires
3. Verify backend receives the payment object
4. Verify `/api/pi/complete` is called
5. Verify payment status updates to "paid"

---

## Debugging Tips

### Enable Verbose Logging
Add to your Pi SDK wrapper:
```typescript
const originalAuthenticate = window.Pi.authenticate
window.Pi.authenticate = function(...args) {
  console.log("[Pi] authenticate called with args:", args)
  return originalAuthenticate.apply(window.Pi, args)
    .then(result => {
      console.log("[Pi] authenticate result:", result)
      return result
    })
    .catch(error => {
      console.error("[Pi] authenticate error:", error.message)
      throw error
    })
}
```

### Check Redis State
If using Redis:
```bash
# Check all payment keys
redis-cli KEYS "payment:*"

# Check stuck payment details
redis-cli GET "payment:YOUR_PAYMENT_ID"

# Manually clear (if needed)
redis-cli DEL "payment:YOUR_PAYMENT_ID"
```

### Monitor Network Requests
In browser DevTools → Network tab:
- Look for POST to `/api/pi/complete`
- Look for POST to `/api/emergency/clear-stuck-payment`
- Verify 200 responses, not 400/500 errors

---

## Summary

The stuck payment issue happens when:
1. A payment gets stuck on Pi's servers
2. Your app's auth handler ignores the incomplete payment callback
3. Pi throws an error that your code doesn't catch
4. The error blocks all subsequent authentications

**The fix requires:**
1. Proper error handling in auth callback
2. Auto-detection and clearing of stuck payments
3. Completion endpoints that process stuck payments
4. Emergency recovery endpoints for manual clearing

**Implementation takes ~30-60 minutes** and prevents this issue permanently.

---

## Questions?

If you encounter issues:
1. Check browser console for [Pi] logs
2. Verify `/api/pi/complete` endpoint exists and accepts POST
3. Verify `/api/emergency/clear-stuck-payment` exists
4. Check Redis/database for stuck payments with "pending" status
5. Enable verbose logging as shown in Debugging Tips section
