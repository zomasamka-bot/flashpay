import "server-only"

import { NextResponse } from "next/server"
import { readRefundPresentation } from "@/lib/refund-presentation-reader"
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

  const result = await readRefundPresentation(refundId)
  console.info("REFUND_PRESENTATION_READ", { refundId, result })
  if (result.outcome === "NOT_FOUND") {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } })
  }
  if (result.outcome === "INDETERMINATE") {
    return NextResponse.json({ error: "Refund status unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }

  return NextResponse.json({ outcome: "FOUND", presentation: result.presentation }, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  })
}
