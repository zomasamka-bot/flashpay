import { NextRequest, NextResponse } from "next/server"
import { authorizeFromHeader } from "@/lib/merchant-auth"
import { redis, isRedisConfigured } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_PDF_BYTES = 512 * 1024
const RECEIPT_FILE_TTL_SECONDS = 60 * 60

function parsePayment(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
  return typeof raw === "object" ? raw as Record<string, unknown> : null
}

function isAuthorizedForPayment(payment: Record<string, unknown>, uid: string, username: string): boolean {
  const merchantUid = typeof payment.merchantUid === "string" ? payment.merchantUid : null
  const merchantId = typeof payment.merchantId === "string" ? payment.merchantId : null
  const payerUid = typeof payment.payerUid === "string" ? payment.payerUid : null
  const payerUidSource = payment.payerUidSource

  const merchantAuthorized = merchantUid ? merchantUid === uid : merchantId === username
  const payerAuthorized = payerUidSource === "verified_u2a" && payerUid === uid
  return merchantAuthorized || payerAuthorized
}

function isGeneratedReceiptPdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 512 || bytes.byteLength > MAX_PDF_BYTES) return false
  const pdf = Buffer.from(bytes)
  const head = pdf.subarray(0, Math.min(pdf.byteLength, 32)).toString("latin1")
  const tail = pdf.subarray(Math.max(0, pdf.byteLength - 64)).toString("latin1")
  if (!head.startsWith("%PDF-1.4") || !tail.includes("%%EOF")) return false

  // Validate the exact image-stream shape produced by receipt-pdf.ts. Do not
  // scan JPEG payload bytes for PDF keywords: arbitrary compressed image bytes
  // can coincidentally contain ASCII sequences such as "/EmbeddedFile".
  const imageMarker = Buffer.from("/Subtype /Image", "latin1")
  const streamMarker = Buffer.from(">>\nstream\n", "latin1")
  const imageMarkerAt = pdf.indexOf(imageMarker)
  if (imageMarkerAt < 0) return false
  const streamMarkerAt = pdf.indexOf(streamMarker, imageMarkerAt)
  if (streamMarkerAt < 0) return false

  const imageHeader = pdf.subarray(imageMarkerAt, streamMarkerAt).toString("latin1")
  const lengthMatch = imageHeader.match(/\/Length\s+(\d+)\s*$/)
  if (!lengthMatch) return false
  const imageLength = Number(lengthMatch[1])
  if (!Number.isSafeInteger(imageLength) || imageLength <= 0) return false

  const imageStart = streamMarkerAt + streamMarker.byteLength
  const imageEnd = imageStart + imageLength
  if (imageEnd + 10 > pdf.byteLength) return false
  if (pdf.subarray(imageEnd, imageEnd + 10).toString("latin1") !== "\nendstream") return false

  const structureText = pdf.subarray(0, imageStart).toString("latin1") + pdf.subarray(imageEnd).toString("latin1")
  if (!structureText.includes("/Im0 Do")) return false
  const forbidden = ["/JavaScript", "/OpenAction", "/EmbeddedFile", "/Launch", "/AcroForm"]
  return forbidden.every((token) => !structureText.includes(token))
}

export async function POST(request: NextRequest) {
  if (!isRedisConfigured) return NextResponse.json({ error: "Receipt sharing unavailable" }, { status: 503 })

  const verified = await authorizeFromHeader(request.headers.get("authorization"))
  if (!verified) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const paymentId = request.headers.get("x-flashpay-payment-id")?.trim() ?? ""
  if (!/^[0-9a-fA-F-]{36}$/.test(paymentId)) {
    return NextResponse.json({ error: "Invalid FlashPay ID" }, { status: 400 })
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/pdf") {
    return NextResponse.json({ error: "PDF required" }, { status: 415 })
  }

  const rawPayment = await redis.get(`payment:${paymentId}`)
  const payment = parsePayment(rawPayment)
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 })
  if (payment.id !== paymentId) return NextResponse.json({ error: "Payment identity conflict" }, { status: 409 })
  if (!isAuthorizedForPayment(payment, verified.uid, verified.username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = new Uint8Array(await request.arrayBuffer())
  if (!isGeneratedReceiptPdf(body)) {
    return NextResponse.json({ error: "Invalid receipt PDF" }, { status: 400 })
  }

  const token = crypto.randomUUID().replaceAll("-", "")
  const filename = `FlashPay-Receipt-${paymentId.replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`
  const record = JSON.stringify({
    paymentId,
    filename,
    pdfBase64: Buffer.from(body).toString("base64"),
    createdAt: new Date().toISOString(),
  })

  await redis.set(`receipt-file:${token}`, record, { ex: RECEIPT_FILE_TTL_SECONDS })
  const url = `${request.nextUrl.origin}/api/receipt-files/${token}`
  return NextResponse.json({ url, expiresIn: RECEIPT_FILE_TTL_SECONDS })
}
