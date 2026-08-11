import "server-only"

import { NextResponse } from "next/server"
import { getRefundCheckpointReadOnly } from "@/lib/refund-checkpoint-store"
import { serverConfig } from "@/lib/server-config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const supplied = request.headers.get("x-refund-internal-secret")
  if (!serverConfig.refundInternalSecret || supplied !== serverConfig.refundInternalSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } })
  }

  const refundId = new URL(request.url).searchParams.get("refundId")
  if (typeof refundId !== "string" || refundId.trim().length === 0) {
    return NextResponse.json({ error: "Invalid refundId" }, { status: 400, headers: { "Cache-Control": "no-store" } })
  }

  const result = await getRefundCheckpointReadOnly(refundId)
  if (result.state === "absent") return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } })
  if (result.state === "uncertain") return NextResponse.json({ error: "Refund status unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } })

  const checkpoint = result.checkpoint
  return NextResponse.json({
    refundId,
    paymentId: checkpoint.paymentId,
    status: checkpoint.status,
    stage: checkpoint.stage,
    amount: checkpoint.amount,
    currency: checkpoint.currency,
    ...(checkpoint.refundPaymentId ? { refundPaymentId: checkpoint.refundPaymentId } : {}),
    ...(checkpoint.refundTxid ? { refundTxid: checkpoint.refundTxid } : {}),
    attemptCount: checkpoint.attemptCount,
    updatedAt: checkpoint.updatedAt,
  }, { status: 200, headers: { "Cache-Control": "no-store" } })
}
