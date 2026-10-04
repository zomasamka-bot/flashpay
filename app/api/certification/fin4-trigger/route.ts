import { type NextRequest, NextResponse } from "next/server"
import {
  fin4AuthorizeRunId,
  fin4AutomationBypassPresent,
  fin4ClaimLaunchForArmedRun,
  fin4IssueInvocationCapability,
} from "@/lib/fin4-live-certification"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 90

type Body = { action: "launch" }

function exactDeploymentOrigin(): string {
  const host = process.env.VERCEL_URL?.trim() ?? ""
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/.test(host)) throw new Error("FIN4_FAIL_CLOSED_DEPLOYMENT_ORIGIN_UNAVAILABLE")
  return `https://${host}`
}

function automationBypassSecret(): string {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? ""
  if (!/^[A-Za-z0-9]{32}$/.test(secret)) throw new Error("FIN4_FAIL_CLOSED_AUTOMATION_BYPASS_UNAVAILABLE")
  return secret
}

export async function GET(request: NextRequest) {
  const runId = fin4AuthorizeRunId(request.headers.get("x-flashpay-fin4-run-id"))
  if (!runId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  const present = fin4AutomationBypassPresent()
  return NextResponse.json({ ok: present, action: "preflight", automationBypassPresent: present, financialAuthorityMutated: false }, { status: present ? 200 : 409 })
}

async function invokeRole(origin: string, runId: string, role: "A" | "B", bypassSecret: string, capability: string) {
  const response = await fetch(`${origin}/api/certification/fin4-trigger-${role.toLowerCase()}`, {
    method: "POST",
    headers: {
      "x-flashpay-fin4-run-id": runId,
      "x-flashpay-fin4-capability": capability,
      "x-vercel-protection-bypass": bypassSecret,
      Accept: "application/json",
    },
    cache: "no-store",
    redirect: "error",
  })
  const payload = await response.json().catch(() => null)
  return { role, status: response.status, ok: response.ok, payload }
}

export async function POST(request: NextRequest) {
  try {
    const runId = fin4AuthorizeRunId(request.headers.get("x-flashpay-fin4-run-id"))
    if (!runId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
    const body = await request.json().catch(() => null) as Body | null
    if (!body || body.action !== "launch" || Object.keys(body).length !== 1) return NextResponse.json({ error: "Invalid body" }, { status: 400 })

    const bypassSecret = automationBypassSecret()
    const armed = await fin4ClaimLaunchForArmedRun(runId)
    const capabilityA = fin4IssueInvocationCapability(runId, "A")
    const capabilityB = fin4IssueInvocationCapability(runId, "B")
    const origin = exactDeploymentOrigin()
    console.log("[FIN-4 LIVE] split-function launch", {
      runId,
      paymentA: armed.paymentA,
      paymentB: armed.paymentB,
      originHost: new URL(origin).host,
      scopedCapabilitiesIssued: true,
      financialAuthorityMutated: false,
    })
    const [a,b] = await Promise.all([
      invokeRole(origin, runId, "A", bypassSecret, capabilityA),
      invokeRole(origin, runId, "B", bypassSecret, capabilityB),
    ])
    console.log("[FIN-4 LIVE] split-function launch results", { runId, aStatus: a.status, bStatus: b.status, aOk: a.ok, bOk: b.ok })
    return NextResponse.json({ ok: a.ok && b.ok, action: "launch", oneShot: true, scopedCapabilities: true, results: [a,b] }, { status: a.ok && b.ok ? 200 : 409 })
  } catch (error) {
    console.error("[FIN-4 LIVE] launch fail-closed", { error: String(error) })
    return NextResponse.json({ error: "FIN4 launch failed closed" }, { status: 409 })
  }
}
