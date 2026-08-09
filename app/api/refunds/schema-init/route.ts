import "server-only"

import { NextResponse } from "next/server"
import { serverConfig } from "@/lib/server-config"
import { activateRefundSchemaReadiness } from "@/lib/refund-schema-init"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const supplied = request.headers.get("x-refund-internal-secret")
  if (!serverConfig.refundInternalSecret || supplied !== serverConfig.refundInternalSecret) {
    return NextResponse.json({ ready: false }, { status: 401 })
  }
  try {
    const result = await activateRefundSchemaReadiness()
    return NextResponse.json(result, { status: result.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ ready: false }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
