import { NextRequest, NextResponse } from "next/server"

import { readCustomerRefundPresentation } from "@/lib/customer-refund-presentation-reader"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

export async function GET(request: NextRequest) {
  const paymentId = request.nextUrl.searchParams.get("paymentId")?.trim() ?? ""
  if (!UUID_PATTERN.test(paymentId)) return response({ error: "Invalid payment ID" }, 400)

  const authorization = request.headers.get("authorization") ?? ""
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? ""
  if (!bearer) return response({ error: "Unauthorized" }, 401)

  let upstream: Response
  let me: unknown
  try {
    upstream = await fetch("https://api.minepi.com/v2/me", {
      headers: { Authorization: `Bearer ${bearer}` },
      cache: "no-store",
    })
    if (upstream.status === 401 || upstream.status === 403) return response({ error: "Unauthorized" }, 401)
    if (!upstream.ok) return response({ error: "Service unavailable" }, 503)
    me = await upstream.json()
  } catch {
    return response({ error: "Service unavailable" }, 503)
  }

  if (typeof me !== "object" || me === null || Array.isArray(me)) {
    return response({ error: "Service unavailable" }, 503)
  }
  const uid = (me as Record<string, unknown>).uid
  const username = (me as Record<string, unknown>).username
  if (typeof uid !== "string" || !uid.trim() || (username !== undefined && typeof username !== "string")) {
    return response({ error: "Service unavailable" }, 503)
  }

  const result = await readCustomerRefundPresentation(paymentId, uid)
  console.info("CUSTOMER_REFUND_PRESENTATION_READ", { paymentId, outcome: result.outcome })
  if (result.outcome === "FORBIDDEN") return response({ error: "Forbidden" }, 403)
  if (result.outcome === "NOT_FOUND") return response({ error: "Not found" }, 404)
  if (result.outcome === "INDETERMINATE") return response({ error: "Service unavailable" }, 503)
  return response({ outcome: "FOUND", presentation: result.presentation }, 200)
}
