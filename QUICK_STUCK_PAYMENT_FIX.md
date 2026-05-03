# Quick Stuck Payment Fix Reference

## Problem
App shows: "A pending payment needs to be handled" - all payments blocked

## Cause
Pi Network detected a stuck payment during authentication and threw an error

## Quick Fix (Immediate Recovery)
\`\`\`bash
curl -X POST https://your-app-url/api/emergency/clear-stuck-payment
\`\`\`

Response: `{ "success": true, "cleared": [...] }`

## Permanent Fix (3 Code Changes)

### 1. Frontend: Catch Auth Error
**File: `lib/pi-sdk.ts`**
\`\`\`typescript
try {
  const result = await Pi.authenticate(["payments"], handleIncompletePayment)
} catch (error) {
  if (error.message.includes("pending payment")) {
    await fetch("/api/emergency/clear-stuck-payment", { method: "POST" })
  }
}
\`\`\`

### 2. Frontend: Handle Incomplete Payment
**File: `lib/pi-sdk.ts`**
\`\`\`typescript
const handleIncompletePayment = async (payment) => {
  if (payment?.identifier) {
    await fetch("/api/pi/complete", {
      method: "POST",
      body: JSON.stringify(payment),
    })
  }
}
\`\`\`

### 3. Backend: Clear Stuck Payments
**File: `app/api/emergency/clear-stuck-payment/route.ts`**
\`\`\`typescript
export async function POST() {
  const keys = await redis.keys("payment:*")
  for (const key of keys) {
    const payment = JSON.parse(await redis.get(key))
    if (payment.status === "pending") {
      payment.status = "cancelled"
      await redis.set(key, JSON.stringify(payment))
    }
  }
  return NextResponse.json({ success: true })
}
\`\`\`

## Testing
1. Clear stuck payment: `POST /api/emergency/clear-stuck-payment`
2. Refresh app
3. Try new payment
4. Should work

## Implementation Time
30-60 minutes for complete fix
