import "server-only"

import type { Payment } from "@/lib/types"
import { readSettlementSubmitHorizonEvidence } from "@/lib/financial-recovery-settlement-submit-horizon-reader"

function record(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v) }

export async function logSettlementSubmitRuntimeDiagnostic(payment: Payment, stage: string): Promise<void> {
  try {
    const hash = payment.a2uPreparedTxHash
    const sequence = payment.a2uPreparedSequence
    const source = payment.a2uFromAddress
    if (typeof hash !== "string" || typeof sequence !== "string" || typeof source !== "string") {
      console.error("[SETTLEMENT_SUBMIT_DIAGNOSTIC]", { paymentId: payment.id, stage, horizonOutcome: "INVALID_PREPARED_IDENTITY" })
      return
    }
    const h = await readSettlementSubmitHorizonEvidence(hash, sequence, source)
    if (h.outcome !== "READ") {
      console.error("[SETTLEMENT_SUBMIT_DIAGNOSTIC]", { paymentId: payment.id, stage, horizonOutcome: h.outcome, observedSourceSequence: h.outcome === "HASH_NOT_FOUND" ? h.observedSourceSequence : null, preparedSequence: sequence })
      return
    }
    const tx = record(h.transaction) ? h.transaction : null
    const op = h.operations.length === 1 && record(h.operations[0]) ? h.operations[0] : null
    const amount = Number(payment.merchantAmount ?? payment.customerAmount)
    const observedAmount = op ? Number(op.amount) : Number.NaN
    const memo = String(payment.a2uPaymentId ?? "").substring(0, 28)
    const checks = {
      hashMatch: tx?.hash === hash,
      sequenceMatch: tx?.source_account_sequence === sequence,
      sourceMatch: tx?.source_account === payment.a2uFromAddress,
      successfulMatch: tx?.successful === true,
      memoTypeMatch: tx?.memo_type === "text",
      memoMatch: tx?.memo === memo,
      operationCountMatch: tx?.operation_count === 1 && h.operations.length === 1,
      operationShapeMatch: op !== null,
      typeMatch: op?.type === "payment",
      operationHashMatch: op?.transaction_hash === hash,
      operationSuccessfulMatch: op?.transaction_successful === true,
      fromMatch: op?.from === payment.a2uFromAddress,
      toMatch: op?.to === payment.a2uToAddress,
      assetMatch: op?.asset_type === "native",
      amountMatch: Number.isFinite(amount) && Number.isFinite(observedAmount) && observedAmount === amount,
    }
    console.error("[SETTLEMENT_SUBMIT_DIAGNOSTIC]", {
      paymentId: payment.id, stage, horizonOutcome: "READ",
      failedChecks: Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k), checks,
      expected: { hash, sequence, source: payment.a2uFromAddress, memo, operationCount: 1, type: "payment", from: payment.a2uFromAddress, to: payment.a2uToAddress, assetType: "native", amount },
      observed: { hash: tx?.hash ?? null, sequence: tx?.source_account_sequence ?? null, source: tx?.source_account ?? null, successful: tx?.successful ?? null, memoType: tx?.memo_type ?? null, memo: tx?.memo ?? null, operationCount: tx?.operation_count ?? null, returnedOperations: h.operations.length, type: op?.type ?? null, operationHash: op?.transaction_hash ?? null, operationSuccessful: op?.transaction_successful ?? null, from: op?.from ?? null, to: op?.to ?? null, assetType: op?.asset_type ?? null, amount: Number.isFinite(observedAmount) ? observedAmount : null },
      authorizesFinancialAction: false,
    })
  } catch (error) {
    console.error("[SETTLEMENT_SUBMIT_DIAGNOSTIC]", { paymentId: payment.id, stage, horizonOutcome: "DIAGNOSTIC_ERROR", error: error instanceof Error ? error.message : "unknown", authorizesFinancialAction: false })
  }
}
