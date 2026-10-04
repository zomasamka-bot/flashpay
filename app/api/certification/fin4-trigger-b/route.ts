import { type NextRequest, NextResponse } from "next/server"
import { executeA2URecovery } from "@/lib/a2u-recovery-service"
import {
  fin4ArmedPaymentForRole,
  fin4AuthorizeRunId,
  fin4ConsumeInvocationCapability,
  fin4RunWithInvocationCapability,
  fin4ValidateInvocationCapability,
} from "@/lib/fin4-live-certification"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 90

export async function POST(request: NextRequest) {
  try {
    const runId = fin4AuthorizeRunId(request.headers.get("x-flashpay-fin4-run-id"))
    if (!runId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
    const paymentId = fin4ArmedPaymentForRole(runId, "B")
    const capability = fin4ValidateInvocationCapability(request.headers.get("x-flashpay-fin4-capability"), runId, "B", paymentId)
    await fin4ConsumeInvocationCapability(capability)
    return await fin4RunWithInvocationCapability(capability, async () => {
      console.log("[FIN-4 LIVE] split trigger", { runId, role: "B", paymentId, route: "B", scopedCapabilityVerified: true })
      const result = await executeA2URecovery(paymentId)
      console.log("[FIN-4 LIVE] split trigger result", { runId, role: "B", paymentId, recoveryStatus: result.status, state: result.state ?? null, error: result.details?.error ?? null })
      return NextResponse.json({ ok: true, role: "B", paymentId, recoveryStatus: result.status, state: result.state ?? null, error: result.details?.error ?? null })
    })
  } catch (error) {
    console.error("[FIN-4 LIVE] split trigger B fail-closed", { error: String(error) })
    return NextResponse.json({ error: "FIN4 trigger B failed closed" }, { status: 409 })
  }
}
