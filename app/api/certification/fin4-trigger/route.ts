import { type NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "crypto"
import { executeA2URecovery } from "@/lib/a2u-recovery-service"
import { fin4ArmedPaymentForRole, fin4ResetBarrierForArmedRun } from "@/lib/fin4-live-certification"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type Body = { action: "reset" } | { action: "run"; role: "A" | "B" }

function exactRunId(request: NextRequest): string | null {
  const expected = process.env.FLASHPAY_FIN4_RUN_ID?.trim()
  const provided = request.headers.get("x-flashpay-fin4-run-id")?.trim()
  if (!expected || !provided) return null
  const a = Buffer.from(expected), b = Buffer.from(provided)
  return a.length === b.length && timingSafeEqual(a,b) ? expected : null
}

export async function POST(request: NextRequest) {
  try {
    const runId = exactRunId(request)
    if (!runId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
    const body = await request.json().catch(()=>null) as Body | null
    if (!body || typeof body !== "object" || !("action" in body)) return NextResponse.json({ error: "Invalid body" }, { status: 400 })
    if (body.action === "reset" && Object.keys(body).length === 1) {
      const armed = await fin4ResetBarrierForArmedRun(runId)
      return NextResponse.json({ ok: true, action: "reset", armedPayments: 2, paymentA: armed.paymentA, paymentB: armed.paymentB })
    }
    if (body.action !== "run" || Object.keys(body).length !== 2 || (body.role !== "A" && body.role !== "B")) return NextResponse.json({ error: "Invalid body" }, { status: 400 })
    const paymentId = fin4ArmedPaymentForRole(runId, body.role)
    console.log("[FIN-4 LIVE] targeted trigger", { runId, role: body.role, paymentId })
    const result = await executeA2URecovery(paymentId)
    return NextResponse.json({ ok: true, action: "run", role: body.role, paymentId, recoveryStatus: result.status, state: result.state ?? null })
  } catch (error) {
    console.error("[FIN-4 LIVE] trigger fail-closed", { error: String(error) })
    return NextResponse.json({ error: "FIN4 trigger failed closed" }, { status: 409 })
  }
}
