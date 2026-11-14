import {requiresTestnetIngress,testnetIngressEnabled,bindTestnetPayer} from "../../../lib/r36-testnet-ingress"
import { type NextRequest, NextResponse } from "next/server"
import { acquireSettlementU2AStartLease, query } from "../../../lib/db"
import { findResumablePaymentStart } from "../../../lib/payment-start-resume"
import { retireCancelledPaymentStart } from "../../../lib/payment-start-cancelled"
import { readPiA2UQueueAdmission } from "../../../lib/pi-a2u-queue-admission"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  if (requiresTestnetIngress() && !testnetIngressEnabled())
    return new Response(JSON.stringify({error:"Testnet financial admission unavailable",code:"TESTNET_INGRESS_HELD"}), {status:503,headers:{"Content-Type":"application/json"}})

  // Timing contains no identity, bearer token, lease or payment payload.
  // Observability must never change the result of an original guard.
  const measure = async <T,>(phase: string, work: () => Promise<T>): Promise<T> => {
    const at = Date.now()
    try { return await work() } finally {
      try { console.info('[Payment start timing]', { phase, durationMs: Date.now() - at }) } catch {}
    }
  }
  try {
    const body = await request.json()
    const paymentId = typeof body?.paymentId === "string" ? body.paymentId.trim() : ""
    const accessToken = typeof body?.accessToken === "string" ? body.accessToken.trim() : ""
    if (!paymentId) return NextResponse.json({ error: "Missing paymentId" }, { status: 400 })
    if (!accessToken) return NextResponse.json({ error: "Pi authentication required", code: "U2A_START_AUTH_REQUIRED" }, { status: 401 })

    // PRE-DR118 D-1: no caller may reserve the durable two-minute start lease
    // from knowledge of a public paymentId alone. Prove a live Pi identity first.
    // The bearer token is verification-only and is never persisted in the lease/checkpoint.
    const identity = await measure('pi_identity', () => fetch("https://api.minepi.com/v2/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      cache: "no-store",redirect:"error",signal:AbortSignal.timeout(10000),
    }))
    if (!identity.ok) {
      if (identity.status === 401 || identity.status === 403)
        return NextResponse.json({ error: "Pi authentication rejected", code: "U2A_START_AUTH_REJECTED" }, { status: 401 })
      return NextResponse.json({ error: "Payment start authority unavailable", code: "U2A_START_INDETERMINATE" }, { status: 503 })
    }
    const verified = await identity.json().catch(() => null)
    const verifiedUid = typeof verified?.uid === "string" ? verified.uid.trim() : ""
    if (!verifiedUid) return NextResponse.json({ error: "Pi authentication invalid", code: "U2A_START_AUTH_INVALID" }, { status: 401 })

    if (requiresTestnetIngress() && await measure('provider_queue', readPiA2UQueueAdmission) !== 'EMPTY')
      return NextResponse.json({error:"Pi outgoing payment readiness unavailable. No new Pi payment was created.",code:"PI_A2U_PROVIDER_HELD"},{status:503})
    // UID is authenticated now; the source wallet is bound only from the
    // canonical verified U2A transaction, before completion/outgoing admission.
    if (requiresTestnetIngress() && !await measure('host_and_payer_binding', () => bindTestnetPayer(paymentId,verifiedUid))) {
      const original = await findResumablePaymentStart(query, paymentId, verifiedUid, process.env.R36_SCOPED_POLICY_DIGEST ?? '')
      if (original) return NextResponse.json({
        success: false, code: "U2A_START_RESUME_REQUEST", resumePaymentId: original,
        error: "Reopen your matching original request before starting payment.",
      }, {status: 409, headers: {"Cache-Control": "no-store"}})
      return NextResponse.json({error:"Testnet payer or budget admission unavailable",code:"TESTNET_INGRESS_HELD"},{status:503})
    }
    let lease = await measure('start_lease', () => acquireSettlementU2AStartLease(paymentId))
    if (lease.outcome === "BLOCKED" && await measure('cancelled_start_reconciliation', () => retireCancelledPaymentStart(paymentId,verifiedUid)))
      lease = await acquireSettlementU2AStartLease(paymentId)
    if (lease.outcome === "ACQUIRED") return NextResponse.json({ success: true, startLeaseToken: lease.token, expiresAt: lease.expiresAt })
    if (lease.outcome === "BLOCKED") return NextResponse.json({ error: "Payment already initiated", code: "U2A_START_BLOCKED" }, { status: 409 })
    return NextResponse.json({ error: "Payment start authority unavailable", code: "U2A_START_INDETERMINATE" }, { status: 503 })
  } catch {
    return NextResponse.json({ error: "Payment start authority unavailable", code: "U2A_START_INDETERMINATE" }, { status: 503 })
  }
}
