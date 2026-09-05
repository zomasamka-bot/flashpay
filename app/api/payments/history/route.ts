import { type NextRequest, NextResponse } from "next/server"
import { authorizeFromHeader } from "@/lib/merchant-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * GET /api/payments/history?merchantId=xxx
 * Returns payment history from the merchant Redis index
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
    let historyIds: unknown
    try {
      const bootstrapMarker = await redis.get("flashpay:merchant-history:v1:bootstrap")
      if (bootstrapMarker !== "done") return NextResponse.json({ error: "Payment history not ready" }, { status: 503 })
      historyIds = await redis.zrange<unknown[]>(`flashpay:merchant:${verifiedMerchant.username}:payments:v1`, 0, safeLimit - 1, { rev: true })
    } catch {
      return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
    }
    if (!Array.isArray(historyIds) || !historyIds.every((id): id is string => typeof id === "string" && id.length > 0 && id === id.trim() && historyIds.indexOf(id) === historyIds.lastIndexOf(id))) {
      return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
    }
    const ids = historyIds
    const payments: Array<Record<string, unknown>> = []
    for (let index = 0; index < ids.length; index += 200) {
      const batchIds = ids.slice(index, index + 200)
      const batchKeys = batchIds.map((id) => `payment:${id}`)
      let values: unknown[]
      try {
        const batchValues = await redis.mget<unknown[]>(batchKeys)
        if (!Array.isArray(batchValues) || batchValues.length !== batchKeys.length) return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
        values = batchValues
      } catch {
        return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
      }
      for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
        const raw = values[valueIndex]
        let payment: unknown
        try {
          payment = typeof raw === "string" ? JSON.parse(raw) : raw
        } catch {
          return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
        }
        if (!isRecord(payment)) return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
        const id = payment.id
        const amount = payment.amount
        const merchant = payment.merchantId
        const status = payment.status
        const createdAt = payment.createdAt
        const merchantUid = payment.merchantUid
        const u2aTxid = payment.u2aTxid
        const a2uTxid = payment.a2uTxid
        const paidAt = payment.paidAt
        const createdAtMs = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN
        if (typeof id !== "string" || id !== batchIds[valueIndex] || typeof merchant !== "string" || merchant !== verifiedMerchant.username || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || typeof createdAt !== "string" || !Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== createdAt || typeof status !== "string" || status.trim().length === 0 || status !== status.trim() || (merchantUid !== undefined && typeof merchantUid !== "string") || (u2aTxid !== undefined && typeof u2aTxid !== "string") || (a2uTxid !== undefined && typeof a2uTxid !== "string") || (paidAt !== undefined && typeof paidAt !== "string")) return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
        payments.push({
          transactionId: id,
          id,
          merchantId: merchant,
          merchantUid,
          amount,
          status,
          createdAt,
          receipt: u2aTxid !== undefined || a2uTxid !== undefined ? {
            transactionId: id,
            txid: u2aTxid || a2uTxid,
            currency: "π",
            timestamp: paidAt,
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
