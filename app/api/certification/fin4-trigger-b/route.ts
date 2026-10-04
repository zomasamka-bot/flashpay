import { type NextRequest, NextResponse } from "next/server"
import { executeA2URecovery } from "@/lib/a2u-recovery-service"
import { fin4ArmedPaymentForRole, fin4AuthorizeRunId, fin4RequireControlledLaunch } from "@/lib/fin4-live-certification"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 90

export async function POST(request: NextRequest) {
  try {
    const runId = fin4AuthorizeRunId(request.headers.get("x-flashpay-fin4-run-id"))
    if (!runId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
    await fin4RequireControlledLaunch(runId)
    const paymentId = fin4ArmedPaymentForRole(runId, "B")
    console.log("[FIN-4 LIVE] split trigger", { runId, role: "B", paymentId, route: "B" })
    const result = await executeA2URecovery(paymentId)
    console.log("[FIN-4 LIVE] split trigger result", { runId, role: "B", paymentId, recoveryStatus: result.status, state: result.state ?? null, error: result.details?.error ?? null })
    return NextResponse.json({ ok: true, role: "B", paymentId, recoveryStatus: result.status, state: result.state ?? null, error: result.details?.error ?? null })
  } catch (error) {
    console.error("[FIN-4 LIVE] split trigger B fail-closed", { error: String(error) })
    return NextResponse.json({ error: "FIN4 trigger B failed closed" }, { status: 409 })
  }
}
