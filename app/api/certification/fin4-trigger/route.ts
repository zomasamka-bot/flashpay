import { type NextRequest, NextResponse } from "next/server"
import {
  fin4AuthorizeRunId,
  fin4AutomationBypassPresent,
  fin4ClaimLaunchForArmedRun,
  fin4IssueInvocationCapability,
  fin4ArmedPaymentForRole,
} from "@/lib/fin4-live-certification"
import { getDurableU2AIngressAuthoritative, getSettlementCheckpointAuthoritative } from "@/lib/db"
import { readSettlementCreatePiEvidence } from "@/lib/financial-recovery-settlement-create-pi-reader"
import { evaluateFinancialRecoveryPiCandidates } from "@/lib/financial-recovery-pi-candidate-rules"
import { readFin4SameWalletSubmitCandidates } from "@/lib/fin4-submit-candidate-reader"
import { readFin4PiPretransactionEvidence } from "@/lib/fin4-pi-pretransaction-reader"
import { executeA2ULocked } from "@/lib/a2u-locked-executor"
import { readFin4QualifiedExistingCandidates } from "@/lib/fin4-candidate-qualification"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 90

type Body = { action: "launch" | "prepare-b-stage1" }

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

async function readArmedReadiness(runId: string) {
  const paymentA = fin4ArmedPaymentForRole(runId, "A")
  const paymentB = fin4ArmedPaymentForRole(runId, "B")
  const durableA = await getSettlementCheckpointAuthoritative(paymentA)
  if (durableA.outcome !== "FOUND") return { ready: false as const, paymentA, paymentB, reason: "ANCHOR_NOT_FOUND" }
  const sourceWallet = durableA.checkpoint.a2uFromAddress
  const scan = await readFin4SameWalletSubmitCandidates(sourceWallet)
  if (!scan) return { ready: false as const, paymentA, paymentB, sourceWallet, reason: "READ_INDETERMINATE" }
  const allowed = new Set(["SETTLEMENT_SUBMIT_ENTRY_CANDIDATE", "PREPARATION_REQUIRED_STAGE1"])
  const a = scan.candidates.find((candidate) => candidate.paymentId === paymentA)
  const b = scan.candidates.find((candidate) => candidate.paymentId === paymentB)
  const ready = Boolean(a && b && allowed.has(a.classification) && allowed.has(b.classification) &&
    a.sourceWallet === sourceWallet && b.sourceWallet === sourceWallet && !a.movementPresent && !b.movementPresent &&
    !a.refundActive && !b.refundActive)
  return {
    ready, paymentA, paymentB, sourceWallet,
    a: a ? { stage: a.stage, classification: a.classification, movementPresent: a.movementPresent, refundActive: a.refundActive } : null,
    b: b ? { stage: b.stage, classification: b.classification, movementPresent: b.movementPresent, refundActive: b.refundActive } : null,
    reason: ready ? null : "ARMED_PAIR_NOT_READY",
  } as const
}

export async function GET(request: NextRequest) {
  const runId = fin4AuthorizeRunId(request.headers.get("x-flashpay-fin4-run-id"))
  if (!runId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })

  if (request.nextUrl.searchParams.get("evidence") === "armed-readiness") {
    const readiness = await readArmedReadiness(runId)
    return NextResponse.json({
      ok: readiness.ready,
      action: "armed-readiness",
      ...readiness,
      financialAuthorityMutated: false,
      piCreateExecuted: false,
      horizonSubmitExecuted: false,
      redisMutated: false,
    }, { status: readiness.ready ? 200 : 409 })
  }

  if (request.nextUrl.searchParams.get("evidence") === "qualified-candidates") {
    const paymentA = fin4ArmedPaymentForRole(runId, "A")
    const durableA = await getSettlementCheckpointAuthoritative(paymentA)
    if (durableA.outcome !== "FOUND") return NextResponse.json({ ok: false, action: "qualified-candidates", outcome: "READ_INDETERMINATE", reason: "ANCHOR_NOT_FOUND", financialAuthorityMutated: false, piMutationExecuted: false, horizonSubmitExecuted: false, redisMutated: false }, { status: 409 })
    const evidence = await readFin4QualifiedExistingCandidates(durableA.checkpoint.a2uFromAddress)
    console.log("[FIN-4 R4L QUALIFIED CANDIDATES]", { runId, outcome: evidence.outcome, sourceWallet: evidence.sourceWallet, durableEligibleCount: "durableEligibleCount" in evidence ? evidence.durableEligibleCount : null, qualifiedCount: "qualifiedCount" in evidence ? evidence.qualifiedCount : null, financialAuthorityMutated: false, piMutationExecuted: false, horizonSubmitExecuted: false, redisMutated: false })
    return NextResponse.json({ action: "qualified-candidates", ...evidence }, { status: evidence.ok ? 200 : 409 })
  }

  if (request.nextUrl.searchParams.get("evidence") === "submit-candidates") {
    const paymentA = fin4ArmedPaymentForRole(runId, "A")
    const durableA = await getSettlementCheckpointAuthoritative(paymentA)
    if (durableA.outcome !== "FOUND") {
      return NextResponse.json({ ok: false, action: "submit-candidates", anchorPaymentId: paymentA, durableAnchorOutcome: durableA.outcome, financialAuthorityMutated: false }, { status: 409 })
    }
    const sourceWallet = durableA.checkpoint.a2uFromAddress
    const scan = await readFin4SameWalletSubmitCandidates(sourceWallet)
    if (!scan) {
      return NextResponse.json({ ok: false, action: "submit-candidates", anchorPaymentId: paymentA, financialAuthorityMutated: false, reason: "READ_INDETERMINATE" }, { status: 409 })
    }
    console.log("[FIN-4 R4G CANDIDATES]", {
      runId,
      anchorPaymentId: paymentA,
      sourceWallet,
      sameWalletRowCount: scan.sameWalletRowCount,
      submitEntryCandidateCount: scan.submitEntryCandidateCount,
      stage1PreparationCandidateCount: scan.stage1PreparationCandidateCount,
      provesTwoSubmitEntryCandidates: scan.provesTwoSubmitEntryCandidates,
      nearestTwo: scan.nearestTwo.map((candidate) => ({ paymentId: candidate.paymentId, stage: candidate.stage, classification: candidate.classification })),
      financialAuthorityMutated: false,
      piCreateExecuted: false,
      horizonSubmitExecuted: false,
    })
    return NextResponse.json({
      ok: true,
      action: "submit-candidates",
      anchorPaymentId: paymentA,
      ...scan,
      financialAuthorityMutated: false,
      piCreateExecuted: false,
      horizonSubmitExecuted: false,
      redisMutated: false,
    })
  }

  if (request.nextUrl.searchParams.get("evidence") === "pi-pretransaction") {
    const paymentId = fin4ArmedPaymentForRole(runId, "B")
    const piPaymentId = request.nextUrl.searchParams.get("piPaymentId")?.trim() ?? ""
    const read = await readFin4PiPretransactionEvidence({ paymentId, piPaymentId })
    return NextResponse.json(read.evidence, { status: read.status })
  }

  if (request.nextUrl.searchParams.get("evidence") === "B") {
    const paymentId = fin4ArmedPaymentForRole(runId, "B")
    const durable = await getDurableU2AIngressAuthoritative(paymentId)
    if (durable.outcome !== "FOUND") {
      return NextResponse.json({ ok: false, action: "pi-evidence-b", durableOutcome: durable.outcome, financialAuthorityMutated: false }, { status: 409 })
    }
    const checkpoint = durable.checkpoint
    const read = await readSettlementCreatePiEvidence(checkpoint.u2aIdentifier)
    if (read.outcome !== "READ") {
      return NextResponse.json({ ok: false, action: "pi-evidence-b", readOutcome: read.outcome, reason: read.reason, financialAuthorityMutated: false }, { status: 409 })
    }
    const evaluation = evaluateFinancialRecoveryPiCandidates({
      source: read.pi.source,
      candidates: read.pi.candidates,
      expected: { branch: "SETTLEMENT", paymentId, amount: checkpoint.customerAmount, merchantUid: checkpoint.merchantUid },
    })
    const exactIdentifier = evaluation.outcome === "FOUND" && typeof evaluation.candidate.identifier === "string"
      ? evaluation.candidate.identifier
      : null
    return NextResponse.json({
      ok: evaluation.outcome !== "INDETERMINATE",
      action: "pi-evidence-b",
      paymentId,
      durableIngress: "FOUND",
      incompleteCandidateCount: read.pi.candidates.length,
      reconciliationOutcome: evaluation.outcome,
      ...(evaluation.outcome === "INDETERMINATE" ? { reason: evaluation.reason } : {}),
      exactIdentifierPresent: exactIdentifier !== null,
      exactIdentifier,
      moneyMovementProven: false,
      financialAuthorityMutated: false,
    }, { status: evaluation.outcome === "INDETERMINATE" ? 409 : 200 })
  }

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
    if (!body || (body.action !== "launch" && body.action !== "prepare-b-stage1") || Object.keys(body).length !== 1) return NextResponse.json({ error: "Invalid body" }, { status: 400 })

    if (body.action === "prepare-b-stage1") {
      const paymentA = fin4ArmedPaymentForRole(runId, "A")
      const paymentB = fin4ArmedPaymentForRole(runId, "B")
      const [anchor, ingress] = await Promise.all([
        getSettlementCheckpointAuthoritative(paymentA),
        getDurableU2AIngressAuthoritative(paymentB),
      ])
      if (anchor.outcome !== "FOUND" || ingress.outcome !== "FOUND") {
        return NextResponse.json({
          ok: false, action: "prepare-b-stage1", paymentA, paymentB,
          reason: "FIN4_R4K_PRECONDITION_NOT_PROVEN",
          anchorOutcome: anchor.outcome, durableIngressOutcome: ingress.outcome,
          horizonSubmitExecuted: false, financialAuthorityMutated: false,
        }, { status: 409 })
      }
      if (anchor.checkpoint.a2uFromAddress.trim() === "" || ingress.checkpoint.paymentId !== paymentB) {
        return NextResponse.json({ ok: false, action: "prepare-b-stage1", paymentA, paymentB, reason: "FIN4_R4K_IDENTITY_NOT_PROVEN", horizonSubmitExecuted: false }, { status: 409 })
      }

      console.log("[FIN-4 R4K] exact B Stage1 preparation start", { runId, paymentA, paymentB, operation: "FIN4_STAGE1_PREPARE", horizonSubmitAuthorized: false })
      const prepared = await executeA2ULocked({ paymentId: paymentB, isRecovery: true, recoveryOperation: "FIN4_STAGE1_PREPARE" })
      const targetAfter = await getSettlementCheckpointAuthoritative(paymentB)
      const readiness = await readArmedReadiness(runId)
      const durableStage1Proven = targetAfter.outcome === "FOUND" && targetAfter.checkpoint.stage === "a2u_created" &&
        targetAfter.checkpoint.a2uFromAddress === anchor.checkpoint.a2uFromAddress && !targetAfter.checkpoint.a2uTxid
      if (!prepared.ok || !durableStage1Proven) {
        console.warn("[FIN-4 R4K] Stage1 preparation not proven", { runId, paymentB, executorOk: prepared.ok, targetOutcome: targetAfter.outcome, targetStage: targetAfter.outcome === "FOUND" ? targetAfter.checkpoint.stage : null })
        return NextResponse.json({
          ok: false, action: "prepare-b-stage1", paymentA, paymentB, executorOk: prepared.ok,
          targetOutcome: targetAfter.outcome, targetStage: targetAfter.outcome === "FOUND" ? targetAfter.checkpoint.stage : null,
          readiness, horizonSubmitExecuted: false, reason: "FIN4_R4K_DURABLE_STAGE1_NOT_PROVEN",
        }, { status: 409 })
      }
      console.log("[FIN-4 R4K] exact B Stage1 preparation proven", { runId, paymentB, stage: targetAfter.checkpoint.stage, sourceWallet: targetAfter.checkpoint.a2uFromAddress, readiness: readiness.ready, horizonSubmitExecuted: false })
      return NextResponse.json({
        ok: true, action: "prepare-b-stage1", paymentA, paymentB,
        targetStage: targetAfter.checkpoint.stage, sourceWallet: targetAfter.checkpoint.a2uFromAddress,
        durableStage1Proven: true, readiness, horizonSubmitExecuted: false,
      })
    }

    const bypassSecret = automationBypassSecret()
    const readiness = await readArmedReadiness(runId)
    if (!readiness.ready) {
      console.warn("[FIN-4 LIVE] launch readiness fail-closed", { runId, reason: readiness.reason, paymentA: readiness.paymentA, paymentB: readiness.paymentB })
      return NextResponse.json({ error: "FIN4 armed pair not ready", action: "launch", readiness, financialAuthorityMutated: false }, { status: 409 })
    }
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
