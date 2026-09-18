import { type NextRequest, NextResponse } from "next/server"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"
import { isRedisConfigured, redis } from "@/lib/redis"
import type { Payment } from "@/lib/types"
import { findRefundCheckpointByPaymentId } from "@/lib/refund-checkpoint-store"
import { readSettlementSubmitHorizonEvidence } from "@/lib/financial-recovery-settlement-submit-horizon-reader"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function validPaymentId(value: string | null): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128 && value === value.trim() && /^[A-Za-z0-9_-]+$/.test(value)
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function compareHorizonBinding(horizon: Extract<Awaited<ReturnType<typeof readSettlementSubmitHorizonEvidence>>, { outcome: "READ" }>, payment: Payment) {
  const transaction = isRecord(horizon.transaction) ? horizon.transaction : null
  const operation = horizon.operations.length === 1 && isRecord(horizon.operations[0]) ? horizon.operations[0] : null
  const expectedAmount = Number(payment.merchantAmount ?? payment.customerAmount)
  const observedAmount = operation ? Number(operation.amount) : Number.NaN
  const expectedMemo = String(payment.a2uPaymentId ?? "").substring(0, 28)
  const checks = {
    hashMatch: transaction?.hash === payment.a2uPreparedTxHash,
    sequenceMatch: transaction?.source_account_sequence === payment.a2uPreparedSequence,
    sourceMatch: transaction?.source_account === payment.a2uFromAddress,
    successfulMatch: transaction?.successful === true,
    memoTypeMatch: transaction?.memo_type === "text",
    memoMatch: transaction?.memo === expectedMemo,
    operationCountMatch: transaction?.operation_count === 1 && horizon.operations.length === 1,
    operationShapeMatch: operation !== null,
    typeMatch: operation?.type === "payment",
    operationHashMatch: operation?.transaction_hash === payment.a2uPreparedTxHash,
    operationSuccessfulMatch: operation?.transaction_successful === true,
    fromMatch: operation?.from === payment.a2uFromAddress,
    toMatch: operation?.to === payment.a2uToAddress,
    assetMatch: operation?.asset_type === "native",
    amountMatch: Number.isFinite(expectedAmount) && Number.isFinite(observedAmount) && observedAmount === expectedAmount,
  }
  const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
  return {
    verdict: failedChecks.length === 0 ? "ALL_BINDING_CHECKS_MATCH" : "BINDING_MISMATCH",
    failedChecks,
    checks,
    expected: {
      hash: payment.a2uPreparedTxHash, sequence: payment.a2uPreparedSequence, source: payment.a2uFromAddress,
      memo: expectedMemo, operationCount: 1, type: "payment", from: payment.a2uFromAddress, to: payment.a2uToAddress,
      assetType: "native", amount: Number.isFinite(expectedAmount) ? expectedAmount : null,
    },
    observed: {
      hash: transaction?.hash ?? null, sequence: transaction?.source_account_sequence ?? null, source: transaction?.source_account ?? null,
      successful: transaction?.successful ?? null, memoType: transaction?.memo_type ?? null, memo: transaction?.memo ?? null,
      operationCount: transaction?.operation_count ?? null, returnedOperations: horizon.operations.length, type: operation?.type ?? null,
      operationHash: operation?.transaction_hash ?? null, operationSuccessful: operation?.transaction_successful ?? null,
      from: operation?.from ?? null, to: operation?.to ?? null, assetType: operation?.asset_type ?? null,
      amount: Number.isFinite(observedAmount) ? observedAmount : operation?.amount ?? null,
    },
  }
}

function canonical(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim()
}

export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: "Unauthorized" }, { status: auth.status })
  if (!isRedisConfigured) return NextResponse.json({ error: "Canonical Redis unavailable" }, { status: 503 })

  const paymentId = new URL(request.url).searchParams.get("paymentId")
  if (!validPaymentId(paymentId)) return NextResponse.json({ error: "Invalid Payment ID" }, { status: 400 })

  try {
    const raw = await redis.get<unknown>(`payment:${paymentId}`)
    if (!raw) return NextResponse.json({ error: "Canonical payment not found" }, { status: 404 })
    const payment = (typeof raw === "string" ? JSON.parse(raw) : raw) as Payment
    if (!payment || payment.id !== paymentId) return NextResponse.json({ error: "Canonical payment identity mismatch" }, { status: 409 })

    const refund = await findRefundCheckpointByPaymentId(paymentId)
    const prepared =
      payment.status === "settlement_pending" &&
      canonical(payment.a2uPaymentId) &&
      canonical(payment.a2uPreparedEnvelopeXdr) &&
      typeof payment.a2uPreparedTxHash === "string" && /^[0-9a-f]{64}$/.test(payment.a2uPreparedTxHash) &&
      typeof payment.a2uPreparedSequence === "string" && /^[1-9][0-9]*$/.test(payment.a2uPreparedSequence) &&
      canonical(payment.a2uFromAddress) && canonical(payment.a2uToAddress)

    if (!prepared) {
      return NextResponse.json({
        paymentId,
        diagnostic: "NOT_PREPARED_SETTLEMENT",
        canonical: { status: payment.status, a2uPaymentId: payment.a2uPaymentId ?? null, a2uTxid: payment.a2uTxid ?? null, horizonSuccessFlag: payment.horizonSuccessFlag === true },
        refund: { state: refund.state },
        authorizesFinancialAction: false,
      }, { headers: { "Cache-Control": "no-store" } })
    }

    const horizon = await readSettlementSubmitHorizonEvidence(payment.a2uPreparedTxHash!, payment.a2uPreparedSequence!, payment.a2uFromAddress!)
    let diagnosis: "MOVEMENT_PRESENT_RECONCILIATION_REQUIRED" | "HASH_ABSENT_SEQUENCE_STILL_AVAILABLE" | "HASH_ABSENT_SEQUENCE_CONSUMED" | "HORIZON_INDETERMINATE" = "HORIZON_INDETERMINATE"
    let observedSourceSequence: string | null = null

    if (horizon.outcome === "READ") diagnosis = "MOVEMENT_PRESENT_RECONCILIATION_REQUIRED"
    else if (horizon.outcome === "HASH_NOT_FOUND") {
      observedSourceSequence = horizon.observedSourceSequence
      const preparedSequence = BigInt(payment.a2uPreparedSequence!)
      const observedSequence = BigInt(horizon.observedSourceSequence)
      diagnosis = observedSequence < preparedSequence ? "HASH_ABSENT_SEQUENCE_STILL_AVAILABLE" : "HASH_ABSENT_SEQUENCE_CONSUMED"
    }

    const binding = horizon.outcome === "READ" ? compareHorizonBinding(horizon, payment) : null

    return NextResponse.json({
      paymentId,
      asOf: new Date().toISOString(),
      diagnostic: diagnosis,
      canonical: {
        status: payment.status,
        a2uPaymentId: payment.a2uPaymentId,
        a2uTxid: payment.a2uTxid ?? null,
        preparedHash: payment.a2uPreparedTxHash,
        preparedSequence: payment.a2uPreparedSequence,
        fromAddress: payment.a2uFromAddress,
        toAddress: payment.a2uToAddress,
        customerAmount: payment.customerAmount ?? null,
        merchantAmount: payment.merchantAmount ?? null,
        horizonSuccessFlag: payment.horizonSuccessFlag === true,
        piCompletionPending: payment.piCompletionPending === true,
        piCompleted: payment.piCompleted === true,
        dbRecorded: payment.dbRecorded === true,
      },
      horizon: { outcome: horizon.outcome, observedSourceSequence },
      binding,
      refund: { state: refund.state },
      safety: {
        readOnly: true,
        storedXdrReturned: false,
        transactionSubmitted: false,
        paymentMutated: false,
        refundMutated: false,
        authorizesFinancialAction: false,
      },
    }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ error: "Payment diagnostic unavailable", authorizesFinancialAction: false }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
