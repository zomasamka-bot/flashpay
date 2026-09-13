import { NextRequest, NextResponse } from "next/server"
import { authorizeFromHeader } from "@/lib/merchant-auth"
import { redis, isRedisConfigured } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_BODY_BYTES = 8 * 1024

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

function boundedDiagnostic(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const allowed = [
    "version", "userAgent", "secureContext", "fileName", "fileType", "fileSize",
    "navigatorShare", "navigatorCanShare", "navigatorCanShareFile", "navigatorCanShareError",
    "webFileShareAttempted", "webFileShareError", "piPresent", "piShareFile",
    "piShareFileArity", "piShareFileAttempted", "piShareFileError", "piNativeFeaturesList",
    "piNativeFeatures", "piNativeFeaturesError",
  ]
  const output: Record<string, unknown> = {}
  for (const key of allowed) {
    if (!(key in input)) continue
    const item = input[key]
    if (typeof item === "string") output[key] = item.slice(0, 600)
    else if (typeof item === "number" || typeof item === "boolean" || item === null) output[key] = item
    else if (key === "piNativeFeatures" && Array.isArray(item)) {
      output[key] = item.slice(0, 50).map((entry) => String(entry).slice(0, 120))
    }
  }
  return output
}

export async function POST(request: NextRequest) {
  if (!isRedisConfigured) return NextResponse.json({ error: "Diagnostics unavailable" }, { status: 503 })

  const verified = await authorizeFromHeader(request.headers.get("authorization"))
  if (!verified) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }

  const record = body as Record<string, unknown>
  const paymentId = typeof record.paymentId === "string" ? record.paymentId.trim() : ""
  if (!/^[0-9a-fA-F-]{36}$/.test(paymentId)) {
    return NextResponse.json({ error: "Invalid FlashPay ID" }, { status: 400 })
  }

  const payment = parsePayment(await redis.get(`payment:${paymentId}`))
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 })
  if (payment.id !== paymentId) return NextResponse.json({ error: "Payment identity conflict" }, { status: 409 })
  if (!isAuthorizedForPayment(payment, verified.uid, verified.username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const diagnostic = boundedDiagnostic(record.diagnostic)
  if (!diagnostic || diagnostic.version !== "k5-share-diag-v1") {
    return NextResponse.json({ error: "Invalid diagnostic" }, { status: 400 })
  }

  console.info("[K5 SHARE DIAGNOSTIC]", {
    paymentId,
    actorUid: verified.uid,
    actorUsername: verified.username,
    diagnostic,
  })

  return NextResponse.json({ ok: true })
}
