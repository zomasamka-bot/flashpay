import type { Payment } from "./types"
import type { FinancialRecoverySettlementSubmitReadOrchestrationResult } from "./financial-recovery-settlement-submit-read-orchestration"
import type { FinancialRecoverySettlementRefundOppositeBindingResult } from "./financial-recovery-settlement-refund-opposite-binding"
import type { ReconcileRefundAbsenceResult } from "./refund-pi-reconciliation"

type PreparedIsNextResult = Extract<
  FinancialRecoverySettlementSubmitReadOrchestrationResult,
  { outcome: "PREPARED_IS_NEXT" }
>

export type FinancialRecoverySettlementSubmitReplayPreGateResult =
  | Readonly<{
      outcome: "ELIGIBLE_EXACT_REPLAY"
      reference: PreparedIsNextResult
      authorizesFinancialAction: false
    }>
  | Readonly<{
      outcome: "BLOCKED"
      reference: null
      authorizesFinancialAction: false
    }>

export type FinancialRecoverySettlementSubmitReplayPreGateInput = Readonly<{
  payment: Payment
  readResult: FinancialRecoverySettlementSubmitReadOrchestrationResult
  oppositeRefund: FinancialRecoverySettlementRefundOppositeBindingResult
  refundPiResult: ReconcileRefundAbsenceResult
}>

export function evaluateFinancialRecoverySettlementSubmitReplayPreGate(
  input: FinancialRecoverySettlementSubmitReplayPreGateInput,
): FinancialRecoverySettlementSubmitReplayPreGateResult {
  if (input.readResult.outcome !== "PREPARED_IS_NEXT") {
    return { outcome: "BLOCKED", reference: null, authorizesFinancialAction: false }
  }
  const read: PreparedIsNextResult = input.readResult
  if (
    input.payment.id !== read.paymentId ||
    input.payment.merchantUid !== read.merchantUid ||
    input.payment.a2uPaymentId !== read.reference.a2uPaymentId ||
    input.payment.a2uFromAddress !== read.reference.fromAddress ||
    input.payment.a2uToAddress !== read.reference.toAddress ||
    input.payment.merchantAmount !== read.reference.amount ||
    input.payment.customerAmount !== read.reference.amount ||
    input.payment.status !== "settlement_pending" ||
    input.payment.a2uTxid !== undefined ||
    input.payment.horizonSuccessFlag === true ||
    input.payment.piCompletionPending === true ||
    input.payment.piCompleted === true ||
    input.payment.requiresDbReconciliation === true ||
    input.payment.dbRecorded === true ||
    input.payment.refundPaymentId !== undefined ||
    input.payment.refundTxid !== undefined ||
    (input.payment.refundStatus !== undefined && input.payment.refundStatus !== "not_started") ||
    input.payment.a2uPreparedEnvelopeXdr !== read.reference.envelopeXdr ||
    input.payment.a2uPreparedTxHash !== read.reference.preparedHash ||
    input.payment.a2uPreparedSequence !== read.reference.preparedSequence ||
    input.oppositeRefund.outcome !== "CLEAR" ||
    input.refundPiResult.outcome !== "CONFIRMED_NONE" ||
    input.refundPiResult.authorizesFinancialAction !== false ||
    input.refundPiResult.reference.paymentId !== read.paymentId ||
    input.refundPiResult.reference.payerUid !== input.payment.payerUid ||
    input.refundPiResult.reference.amount !== input.payment.customerAmount ||
    input.refundPiResult.reference.a2uPaymentId !== read.reference.a2uPaymentId
  ) {
    return { outcome: "BLOCKED", reference: null, authorizesFinancialAction: false }
  }

  return { outcome: "ELIGIBLE_EXACT_REPLAY", reference: read, authorizesFinancialAction: false }
}
