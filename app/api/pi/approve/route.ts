import { type NextRequest } from "next/server"
import { Redis } from "@upstash/redis"

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Initialize Upstash Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
})

// Check if Redis is configured
const isKvConfigured = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)

interface PiPaymentDTO {
  identifier: string
  user_uid: string
  amount: number
  memo: string
  metadata: {
    paymentId: string
  }
  from_address: string
  to_address: string
  direction: string
  network: string
  created_at: string
  status: {
    developer_approved: boolean
    transaction_verified: boolean
    developer_completed: boolean
    cancelled: boolean
    user_cancelled: boolean
  }
}

// POST /api/pi/approve - Called by Pi Network when payment is initiated
export async function POST(request: NextRequest) {
  const startMs = Date.now()
  
  console.log("[Pi Webhook] ========================================")
  console.log("[Pi Webhook] ⚡ APPROVE ENDPOINT CALLED")
  console.log("[Pi Webhook] Timestamp:", new Date().toISOString())
  
  try {
    // Parse payment data from Pi Network
    const paymentDTO: PiPaymentDTO = await request.json()
    
    console.log("[Pi Webhook] Payment data received:")
    console.log("[Pi Webhook] - Pi Payment ID:", paymentDTO.identifier)
    console.log("[Pi Webhook] - Amount:", paymentDTO.amount)
    console.log("[Pi Webhook] - Our Payment ID:", paymentDTO.metadata?.paymentId)
    
    const paymentId = paymentDTO.metadata?.paymentId
    
    if (!paymentId) {
      console.error("[Pi Webhook] ❌ Missing paymentId in metadata")
      return new Response(JSON.stringify({ error: "Missing payment ID" }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    // CRITICAL: Call Pi Network's API to approve the payment
    // This actually authorizes the blockchain transaction
    console.log("[Pi Webhook] ⚡ Calling Pi API to approve payment...")
    
    const piApiUrl = `https://api.minepi.com/v2/payments/${paymentDTO.identifier}/approve`
    const piApiKey = process.env.PI_API_KEY
    
    if (!piApiKey) {
      console.error("[Pi Webhook] ❌ PI_API_KEY not configured")
      return new Response(JSON.stringify({ error: "Server not configured" }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    const approvalResponse = await fetch(piApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${piApiKey}`,
        'Content-Type': 'application/json',
      },
    })
    
    if (!approvalResponse.ok) {
      const errorText = await approvalResponse.text()
      console.error("[Pi Webhook] ❌ Pi API approval failed:", approvalResponse.status, errorText)
      return new Response(JSON.stringify({ error: "Approval failed" }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    console.log("[Pi Webhook] ✅ Payment approved via Pi API successfully")
    
    // Store payment in Redis
    if (isKvConfigured) {
      await redis.set(`payment:${paymentId}`, JSON.stringify({
        id: paymentId,
        amount: paymentDTO.amount,
        note: paymentDTO.memo || "",
        status: "pending",
        piPaymentId: paymentDTO.identifier,
        userUid: paymentDTO.user_uid,
      }))
      console.log("[Pi Webhook] ✅ Stored in Redis:", paymentId)
    }
    
    console.log("[Pi Webhook] Total time:", Date.now() - startMs, "ms")
    console.log("[Pi Webhook] ========================================")
    
    // Return success to Pi Network
    return new Response(null, { status: 200 })
    
  } catch (error) {
    console.error("[Pi Webhook] ❌ Error:", error)
    return new Response(JSON.stringify({ error: "Internal server error" }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
