import { type NextRequest, NextResponse } from "next/server"
import { authorizeFromHeader } from "@/lib/merchant-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * GET /api/payments/history?merchantId=xxx
 * Returns persistent payment history from PostgreSQL
 * SECURITY: Requires Bearer token with verified Pi identity
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Parse URL and limit
    const { searchParams } = new URL(request.url)
    const merchantId = searchParams.get("merchantId")
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 1000)

    if (!merchantId) {
      return NextResponse.json({ error: "merchantId required" }, { status: 400 })
    }

    // 2. Verify Bearer token
    const authHeader = request.headers.get("authorization")
    const verifiedMerchant = await authorizeFromHeader(authHeader)
    
    if (!verifiedMerchant) {
      console.warn("[Payment History] Missing or invalid authorization header")
      return NextResponse.json(
        { error: "Unauthorized - missing authorization" },
        { status: 401 }
      )
    }
    
    if (verifiedMerchant.username !== merchantId) {
      console.warn("[Payment History] Unauthorized access attempt - username mismatch:", {
        requestedMerchant: merchantId,
        verifiedUsername: verifiedMerchant.username,
      })
      return NextResponse.json(
        { error: "Unauthorized - merchant identity verification failed" },
        { status: 403 }
      )
    }

    const safeLimit = Number.isNaN(limit) ? 100 : Math.max(1, Math.min(limit, 1000))
    const { redis, isRedisConfigured } = await import("@/lib/redis")
    if (!isRedisConfigured) return NextResponse.json({ error: "Active payment history unavailable" }, { status: 503 })
    const bootstrapMarker = await redis.get("flashpay:merchant-history:v1:bootstrap")
    if (bootstrapMarker !== "done") return NextResponse.json({ error: "Payment history not ready" }, { status: 503 })

    const historyIds = await redis.zrange<string[]>(`flashpay:merchant:${verifiedMerchant.username}:payments:v1`, 0, safeLimit - 1, { rev: true })
    const ids = [...new Set(historyIds.filter((id) => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()))]
    const payments: Array<Record<string, unknown>> = []
    for (let index = 0; index < ids.length; index += 200) {
      const batchIds = ids.slice(index, index + 200)
      const batchKeys = batchIds.map((id) => `payment:${id}`)
      const values = await redis.mget<unknown[]>(batchKeys)
      if (!Array.isArray(values) || values.length !== batchKeys.length) return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
      for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
        const raw = values[valueIndex]
        let payment: unknown
        try {
          payment = typeof raw === "string" ? JSON.parse(raw) : raw
        } catch {
          continue
        }
        if (!isRecord(payment)) continue
        const id = payment.id
        const amount = payment.amount
        const merchant = payment.merchantId
        const status = payment.status
        const createdAt = payment.createdAt
        if (typeof id !== "string" || id !== batchIds[valueIndex] || typeof merchant !== "string" || merchant !== verifiedMerchant.username || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt)) || typeof status !== "string" || status.trim().length === 0) continue
        payments.push({
          transactionId: id,
          id,
          merchantId: merchant,
          merchantUid: payment.merchantUid,
          amount,
          status,
          createdAt,
          receipt: typeof payment.u2aTxid === "string" || typeof payment.a2uTxid === "string" ? {
            transactionId: id,
            txid: payment.u2aTxid || payment.a2uTxid,
            currency: "π",
            timestamp: payment.paidAt,
          } : null,
        })
      }
    }
    const totalAmount = payments.reduce((sum, payment) => sum + (typeof payment.amount === "number" ? payment.amount : 0), 0)
    return NextResponse.json({ payments, balance: { total: totalAmount, currency: "π" }, source: "redis" })
  } catch (error) {
    console.error("[Payment History] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch payment history" },
      { status: 500 }
    )
  }
}
