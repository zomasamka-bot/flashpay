import { type NextRequest, NextResponse } from "next/server"
import { getReceipt, getReceiptByU2AIdentifier } from "@/lib/db"
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

async function resolveLegacyFlashPayId(receipt: ReceiptRow, merchantUsername: string): Promise<string | null> {
  if (!isRedisConfigured || !serverConfig.isPiApiKeyConfigured || typeof receipt.u2a_identifier !== "string" || !receipt.u2a_identifier) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(receipt.u2a_identifier)}`, {
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
    if (!canonical || canonical.piPaymentId !== receipt.u2a_identifier) return null
    return candidate
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function buildReceiptView(receipt: ReceiptRow, flashPayPaymentId: string, merchantName: string, customerName: string | null): FlashPayReceiptView | null {
  const amount = Number(receipt.customer_amount ?? receipt.amount)
  const occurredAt = receipt.timestamp || receipt.created_at
  if (!Number.isFinite(amount) || amount <= 0 || typeof occurredAt !== "string" || !Number.isFinite(new Date(occurredAt).getTime())) return null
  return {
    flashPayPaymentId,
    merchantName,
    customerName,
    amount,
    currency: "π",
    transactionType: "payment",
    status: toReceiptStatus(receipt.settlement_status),
    occurredAt,
    note: receipt.description || null,
  }
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
        id,
        verifiedMerchant.username,
        normalizeReceiptName(canonicalPayment.payerUsername) ?? normalizeReceiptName(receipt.payer_username),
      )
      if (!view) return NextResponse.json({ error: "Receipt presentation unavailable" }, { status: 503 })
      return NextResponse.json(view)
    }

    // Legacy links/bookmarks may still contain the internal transaction ID.
    const legacyReceipt = await getReceipt(id)
    if (!legacyReceipt) return NextResponse.json({ error: "Receipt not found" }, { status: 404 })
    if (legacyReceipt.merchant_id !== verifiedMerchant.username) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

    const flashPayPaymentId = await resolveLegacyFlashPayId(legacyReceipt, verifiedMerchant.username)
    if (!flashPayPaymentId) return NextResponse.json({ error: "Canonical FlashPay ID unavailable" }, { status: 503 })
    const canonicalLegacyPayment = await loadCanonicalPayment(flashPayPaymentId, verifiedMerchant.username)
    const view = buildReceiptView(
      legacyReceipt,
      flashPayPaymentId,
      verifiedMerchant.username,
      normalizeReceiptName(canonicalLegacyPayment?.payerUsername) ?? normalizeReceiptName(legacyReceipt.payer_username),
    )
    if (!view) return NextResponse.json({ error: "Receipt presentation unavailable" }, { status: 503 })
    return NextResponse.json(view)
  } catch (error) {
    console.error("[Receipts API] Error:", error)
    return NextResponse.json({ error: "Failed to fetch receipt" }, { status: 500 })
  }
}
