import { type NextRequest } from "next/server"
import { Redis } from "@upstash/redis"

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Initialize Upstash Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
})

// Check if Redis is configured
const isKvConfigured = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)

// Platform API: POST /v2/payments/{id}/approve
export function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const startMs = Date.now()
  
  console.log("[Platform API] ========================================")
  console.log("[Platform API] APPROVE called at", new Date().toISOString())
  console.log("[Platform API] Request URL:", request.url)
  
  // Extract payment ID from URL
  params.then(({ id: piPaymentId }) => {
    console.log("[Platform API] [Background] Pi Payment ID from URL:", piPaymentId)
    
    // Parse request body
    request.json().then((body: any) => {
      console.log("[Platform API] [Background] Request body:", body)
      
      const paymentId = body.metadata?.paymentId || piPaymentId
      
      if (isKvConfigured) {
        redis.set(`payment:${paymentId}`, JSON.stringify({
          id: paymentId,
          amount: body.amount,
          status: "pending",
          piPaymentId: piPaymentId,
        })).then(() => {
          console.log("[Platform API] [Background] ✅ Stored in Redis:", paymentId)
        }).catch((err: any) => {
          console.error("[Platform API] [Background] ❌ Redis error:", err)
        })
      } else {
        console.warn("[Platform API] [Background] ⚠️ Redis not configured")
      }
    }).catch((err) => {
      console.error("[Platform API] [Background] Parse error:", err)
    })
  })
  
  // Return immediate 200 OK
  const response = new Response(null, { status: 200 })
  
  console.log("[Platform API] ⚡ Responding 200 OK in", Date.now() - startMs, "ms")
  console.log("[Platform API] ========================================")
  
  return response
}
