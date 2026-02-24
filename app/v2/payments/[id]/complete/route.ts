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

// Platform API: POST /v2/payments/{id}/complete
export function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const startMs = Date.now()
  
  console.log("[Platform API] ========================================")
  console.log("[Platform API] COMPLETE called at", new Date().toISOString())
  console.log("[Platform API] Request URL:", request.url)
  
  // Extract payment ID from URL
  params.then(({ id: piPaymentId }) => {
    console.log("[Platform API] [Background] Pi Payment ID from URL:", piPaymentId)
    
    // Parse request body
    request.json().then((body: any) => {
      console.log("[Platform API] [Background] Request body:", body)
      console.log("[Platform API] [Background] Transaction:", body.transaction)
      
      const paymentId = body.metadata?.paymentId || piPaymentId
      const txid = body.transaction?.txid
      
      if (isKvConfigured) {
        redis.get(`payment:${paymentId}`).then((data: any) => {
          const existingPayment = data ? (typeof data === 'string' ? JSON.parse(data) : data) : null
          const updatedPayment = {
            ...existingPayment,
            status: "PAID",
            paidAt: new Date().toISOString(),
            txid: txid,
            piPaymentId: piPaymentId,
          }
          
          return redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))
        }).then(() => {
          console.log("[Platform API] [Background] ✅✅✅ Payment COMPLETED in Redis:", paymentId)
        }).catch((err: any) => {
          console.error("[Platform API] [Background] ❌ Complete error:", err)
        })
      } else {
        console.warn("[Platform API] [Background] ⚠️ Redis not configured - cannot complete payment")
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
