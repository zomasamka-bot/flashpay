import { type NextRequest, NextResponse } from "next/server"
import { authorizeFromHeader } from "@/lib/merchant-auth"
import { listDurableMerchantHistoryIdentities, readMerchantHistoryCoverage } from "@/lib/merchant-history-durable"

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
    // Read the entire bounded index before applying limit: a corrupted Redis score
    // can otherwise hide the true newest payment outside the requested page.
    const MAX_VERIFIABLE_HISTORY = 2000
    let historyIds: unknown
    try {
      // A cached "done" marker is not a substitute for current PostgreSQL coverage.
      const coverage = await readMerchantHistoryCoverage()
      if (!coverage.completeChronology) return NextResponse.json({
        error: "Payment history original creation authority incomplete",
        chronologyComplete: false,
        historicalMembershipEndpoint: "/api/payments/history/unverified",
      }, { status: 503 })
      const bootstrapMarker = await redis.get("flashpay:merchant-history:v1:bootstrap")
      if (bootstrapMarker !== "done") return NextResponse.json({ error: "Payment history not ready" }, { status: 503 })
      historyIds = await redis.zrange<unknown[]>(`flashpay:merchant:${verifiedMerchant.username}:payments:v1`, 0, MAX_VERIFIABLE_HISTORY, { rev: true })
    } catch {
      return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
    }
    if (!Array.isArray(historyIds) || !historyIds.every((id): id is string => typeof id === "string" && id.length > 0 && id === id.trim() && historyIds.indexOf(id) === historyIds.lastIndexOf(id))) {
      return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
    }
    // Refuse to certify a truncated index. Never return a misleading partial page.
    if (historyIds.length > MAX_VERIFIABLE_HISTORY) return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
    // Redis bootstrap and score consistency cannot establish durable membership.
    // Compare the COMPLETE bounded merchant index to PostgreSQL, not just a page.
    let durableIdentities: Awaited<ReturnType<typeof listDurableMerchantHistoryIdentities>>
    try { durableIdentities = await listDurableMerchantHistoryIdentities() } catch {
      return NextResponse.json({ error: "Payment history durable authority unavailable" }, { status: 503 })
    }
    const durableForMerchant = durableIdentities.filter(identity => identity.merchantId === verifiedMerchant.username)
    const expected = new Map(durableForMerchant.map(identity => [identity.paymentId, identity]))
    if (expected.size !== historyIds.length || historyIds.some(id => !expected.has(id))) {
      return NextResponse.json({ error: "Payment history durable membership contradictory" }, { status: 503 })
    }
    const ids = historyIds
    let previousCreatedAtMs = Number.POSITIVE_INFINITY
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
        const durable = expected.get(id)
        if (!durable || merchantUid !== durable.merchantUid || amount !== durable.amount || createdAt !== durable.createdAt) {
          return NextResponse.json({ error: "Payment history durable projection contradictory" }, { status: 503 })
        }
        // B-FINAL-07A: verify the actual sorted-set score, not just the
        // relative order of Redis projections. A monotonic but wrong score
        // can otherwise pass the ordering check and corrupt pagination.
        // This is a read-only consistency guard, NOT PostgreSQL coverage proof.
        let indexedScore: unknown
        try {
          indexedScore = await redis.zscore(`flashpay:merchant:${verifiedMerchant.username}:payments:v1`, id)
        } catch {
          return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
        }
        if (typeof indexedScore !== "number" || !Number.isSafeInteger(indexedScore) || indexedScore !== createdAtMs) {
          return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
        }
        // The index ordering must agree with immutable payment creation times.
        // Checking only the requested page would miss a newer excluded payment.
        if (!Number.isSafeInteger(createdAtMs) || createdAtMs > previousCreatedAtMs) return NextResponse.json({ error: "Payment history unavailable" }, { status: 503 })
        previousCreatedAtMs = createdAtMs
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
    const visiblePayments = payments.slice(0, safeLimit)
    const totalAmount = visiblePayments.reduce((sum, payment) => sum + (typeof payment.amount === "number" ? payment.amount : 0), 0)
    return NextResponse.json({ payments: visiblePayments, balance: { total: totalAmount, currency: "π" }, source: "redis" })
  } catch (error) {
    console.error("[Payment History] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch payment history" },
      { status: 500 }
    )
  }
}
