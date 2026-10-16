import { type NextRequest, NextResponse } from "next/server"
import { getReceipt, getReceiptByU2AIdentifier, query } from "@/lib/db"
import { buildPostgresHistoricalReceipt } from "@/lib/legacy-receipt"
import { authorizeFromHeader } from "@/lib/merchant-auth"
import { redis, isRedisConfigured } from "@/lib/redis"
import { serverConfig } from "@/lib/server-config"
import { normalizeReceiptName, toReceiptStatus } from "@/lib/receipt-presentation"
import type { FlashPayReceiptView, ReceiptRow } from "@/lib/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function loadCanonicalPayment(flashPayPaymentId: string, merchantUsername: string): Promise<Record<string, unknown> | null> {
  if (!isRedisConfigured) return null
  try {
    const raw = await redis.get(`payment:${flashPayPaymentId}`)
    const payment = asRecord(typeof raw === "string" ? JSON.parse(raw) : raw)
    if (!payment || payment.id !== flashPayPaymentId || payment.merchantId !== merchantUsername) return null
    return payment
  } catch {
    return null
  }
}

async function resolveFromMerchantHistory(piPaymentId: string, merchantUsername: string): Promise<string | null> {
  if (!isRedisConfigured) return null
  try {
    const historyIds = await redis.zrange<unknown[]>(`flashpay:merchant:${merchantUsername}:payments:v1`, 0, 999, { rev: true })
    if (!Array.isArray(historyIds) || historyIds.length > 1000) return null

    let matchedId: string | null = null
    for (let index = 0; index < historyIds.length; index += 200) {
      const batch = historyIds.slice(index, index + 200)
      if (batch.some((id) => typeof id !== "string" || !id || id !== id.trim())) return null
      const ids = batch as string[]
      const values = await redis.mget<unknown[]>(ids.map((id) => `payment:${id}`))
      if (!Array.isArray(values) || values.length !== ids.length) return null

      for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
        const raw = values[valueIndex]
        const payment = asRecord(typeof raw === "string" ? JSON.parse(raw) : raw)
        if (!payment || payment.id !== ids[valueIndex] || payment.merchantId !== merchantUsername) continue
        if (payment.piPaymentId !== piPaymentId) continue
        if (matchedId !== null && matchedId !== ids[valueIndex]) return null
        matchedId = ids[valueIndex]
      }
    }
    return matchedId
  } catch {
    return null
  }
}

async function resolveLegacyFlashPayId(receipt: ReceiptRow, merchantUsername: string): Promise<string | null> {
  const piPaymentId = typeof receipt.u2a_identifier === "string" ? receipt.u2a_identifier.trim() : ""
  if (!piPaymentId) return null

  // First use FlashPay's own bounded merchant history projection. The candidate
  // is accepted only when the canonical payment matches merchant + exact Pi U2A ID.
  const historyCandidate = await resolveFromMerchantHistory(piPaymentId, merchantUsername)
  if (historyCandidate) return historyCandidate

  // Compatibility fallback for older records outside the bounded merchant history window.
  if (!serverConfig.isPiApiKeyConfigured) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(piPaymentId)}`, {
      headers: { Authorization: `Key ${serverConfig.piApiKey}`, "Content-Type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payment = asRecord(await response.json())
    const metadata = payment ? asRecord(payment.metadata) : null
    const candidate = typeof metadata?.paymentId === "string" ? metadata.paymentId.trim() : ""
    if (!candidate) return null
    const canonical = await loadCanonicalPayment(candidate, merchantUsername)
    if (!canonical || canonical.piPaymentId !== piPaymentId) return null
    return candidate
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeReceiptTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? value.toISOString() : null
  }
  if (typeof value !== "string" || !value.trim()) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function normalizeReceiptNote(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function buildReceiptView(
  receipt: ReceiptRow,
  canonicalPayment: Record<string, unknown>,
  flashPayPaymentId: string,
  merchantName: string,
  customerName: string | null,
): FlashPayReceiptView | null {
  // The PostgreSQL receipt proves the durable settlement record exists, but all
  // user-facing payment facts come from the canonical FlashPay payment so the
  // merchant and customer see the same receipt projection.
  const amount = Number(canonicalPayment.customerAmount ?? canonicalPayment.amount)
  const occurredAt = normalizeReceiptTimestamp(canonicalPayment.paidAt)
    ?? normalizeReceiptTimestamp(canonicalPayment.createdAt)
  if (!Number.isFinite(amount) || amount <= 0 || occurredAt === null) return null

  return {
    flashPayPaymentId,
    merchantName,
    customerName,
    amount,
    currency: "π",
    transactionType: "payment",
    status: toReceiptStatus(receipt.settlement_status),
    occurredAt,
    note: normalizeReceiptNote(canonicalPayment.note),
  }
}

/** The historical receipt remains readable from durable PostgreSQL even when
 * the Redis payment projection is missing. This does not certify a FlashPay ID. */
async function readHistoricalReceipt(transactionId: string, merchantUsername: string) {
  const rows = await query(`
    SELECT t.id AS "transactionId", t.merchant_id AS "transactionMerchantId",
           t.merchant_uid AS "transactionMerchantUid", t.payment_id AS "transactionPaymentId",
           t.amount::text AS "transactionAmount", t.description AS "transactionDescription",
           r.merchant_id AS "receiptMerchantId", r.merchant_uid AS "receiptMerchantUid",
           r.amount::text AS "receiptAmount", r.customer_amount::text AS "customerAmount",
           r.merchant_amount::text AS "merchantAmount", r.app_commission::text AS "appCommission",
           r.currency AS "receiptCurrency", r.u2a_identifier AS "receiptU2aIdentifier",
           r.settlement_status AS "receiptSettlementStatus", r.timestamp AS "receiptTimestamp",
           r.payer_username AS "payerUsername"
    FROM transactions t INNER JOIN receipts r ON r.transaction_id = t.id
    WHERE t.id = $1 AND t.merchant_id = $2 LIMIT 2
  `, [transactionId, merchantUsername])
  if (Array.isArray(rows) && rows.length === 0) {
    return NextResponse.json({ error: "Receipt not found" }, { status: 404 })
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    return NextResponse.json({ error: "Historical receipt authority unavailable" }, { status: 503 })
  }
  const view = buildPostgresHistoricalReceipt(rows[0], merchantUsername)
  if (!view) return NextResponse.json({ error: "Historical receipt contradiction" }, { status: 503 })
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } })
}

/**
 * GET /api/receipts/[id]
 * Preferred lookup: FlashPay application payment ID -> canonical Redis payment -> verified Pi U2A identifier -> PostgreSQL receipt.
 * Compatibility fallback: legacy transaction ID, but still resolves and returns the canonical FlashPay ID before presentation.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Transaction storage not configured" }, { status: 503 })

  try {
    const { id } = await params
    if (!id) return NextResponse.json({ error: "FlashPay ID required" }, { status: 400 })

    const verifiedMerchant = await authorizeFromHeader(request.headers.get("authorization"))
    if (!verifiedMerchant) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    // Normal K3/K4 path: user-facing FlashPay ID first.
    const canonicalPayment = await loadCanonicalPayment(id, verifiedMerchant.username)
    if (canonicalPayment) {
      const piPaymentId = typeof canonicalPayment.piPaymentId === "string" ? canonicalPayment.piPaymentId.trim() : ""
      if (!piPaymentId) return NextResponse.json({ error: "Receipt not available yet" }, { status: 404 })
      const receipt = await getReceiptByU2AIdentifier(piPaymentId)
      if (!receipt) return NextResponse.json({ error: "Receipt not found" }, { status: 404 })
      if (receipt.merchant_id !== verifiedMerchant.username) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      const view = buildReceiptView(
        receipt,
        canonicalPayment,
        id,
        verifiedMerchant.username,
        normalizeReceiptName(canonicalPayment.payerUsername) ?? normalizeReceiptName(receipt.payer_username),
      )
      if (!view) return NextResponse.json({ error: "Receipt presentation unavailable" }, { status: 503 })
      return NextResponse.json(view)
    }

    // A PostgreSQL transaction UUID is already a durable receipt lookup key.
    // Prefer the authenticated DB pair directly; Redis history chronology is
    // deliberately NOT a prerequisite for displaying a historical receipt.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return readHistoricalReceipt(id, verifiedMerchant.username)
    }

    // Legacy links/bookmarks may still contain the internal transaction ID.
    const legacyReceipt = await getReceipt(id)
    if (!legacyReceipt) return NextResponse.json({ error: "Receipt not found" }, { status: 404 })
    if (legacyReceipt.merchant_id !== verifiedMerchant.username) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

    const flashPayPaymentId = await resolveLegacyFlashPayId(legacyReceipt, verifiedMerchant.username)
    if (!flashPayPaymentId) {
      return readHistoricalReceipt(id, verifiedMerchant.username)
    }
    const canonicalLegacyPayment = await loadCanonicalPayment(flashPayPaymentId, verifiedMerchant.username)
    // A Pi/Redis history match is only a presentation hint. If the canonical
    // projection disappeared, retain the verified PostgreSQL receipt instead
    // of turning a durable historical receipt into a 503.
    if (!canonicalLegacyPayment) return readHistoricalReceipt(id, verifiedMerchant.username)
    const view = buildReceiptView(
      legacyReceipt,
      canonicalLegacyPayment,
      flashPayPaymentId,
      verifiedMerchant.username,
      normalizeReceiptName(canonicalLegacyPayment.payerUsername) ?? normalizeReceiptName(legacyReceipt.payer_username),
    )
    if (!view) return NextResponse.json({ error: "Receipt presentation unavailable" }, { status: 503 })
    return NextResponse.json(view)
  } catch (error) {
    console.error("[Receipts API] Error:", error)
    return NextResponse.json({ error: "Failed to fetch receipt" }, { status: 500 })
  }
}
