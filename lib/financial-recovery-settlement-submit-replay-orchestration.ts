import "server-only"

import type { Payment } from "./types"
import { findRefundCheckpointByPaymentId } from "./refund-checkpoint-store"
import { evaluateSettlementRefundCheckpointBarrier } from "./financial-recovery-settlement-refund-checkpoint-barrier"
import { readFinancialRecoverySettlementSubmitEvidence } from "./financial-recovery-settlement-submit-read-orchestration"
import { reconcileRefundAbsenceForPayment } from "./refund-pi-reconciliation"
import { evaluateFinancialRecoverySettlementRefundOppositeBinding } from "./financial-recovery-settlement-refund-opposite-binding"
import { evaluateFinancialRecoverySettlementSubmitReplayPreGate } from "./financial-recovery-settlement-submit-replay-pre-gate"
import { evaluateFinancialRecoverySettlementSubmitReplayGate } from "./financial-recovery-settlement-submit-replay-gate"
import type { FinancialRecoverySettlementSubmitReplayGateResult } from "./financial-recovery-settlement-submit-replay-gate"

const blocked = (): FinancialRecoverySettlementSubmitReplayGateResult => ({
  outcome: "BLOCKED",
  reference: null,
  mode: null,
  moneyMovementProven: false,
  authorizesFinancialAction: false,
})

const canonicalString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value === value.trim()

export async function executeFinancialRecoverySettlementSubmitReplay(
  input: { payment: Payment; paymentId: string },
): Promise<FinancialRecoverySettlementSubmitReplayGateResult> {
  const { payment, paymentId } = input
  if (
    payment.id !== paymentId ||
    !canonicalString(payment.merchantUid) ||
    !canonicalString(payment.payerUid) ||
    !canonicalString(payment.a2uPaymentId) ||
    !canonicalString(payment.a2uFromAddress) ||
    !canonicalString(payment.a2uToAddress) ||
    !canonicalString(payment.a2uPreparedEnvelopeXdr) ||
    !canonicalString(payment.a2uPreparedTxHash) ||
    !canonicalString(payment.a2uPreparedSequence) ||
    !Number.isFinite(payment.customerAmount) || payment.customerAmount <= 0 ||
    !Number.isFinite(payment.merchantAmount) || payment.merchantAmount <= 0
  ) return blocked()

  try {
    const readResult = await readFinancialRecoverySettlementSubmitEvidence({
      xdrInput: {
        a2uPaymentId: payment.a2uPaymentId,
        fromAddress: payment.a2uFromAddress,
        toAddress: payment.a2uToAddress,
        amount: payment.merchantAmount,
        envelopeXdr: payment.a2uPreparedEnvelopeXdr,
        preparedHash: payment.a2uPreparedTxHash,
        preparedSequence: payment.a2uPreparedSequence,
      },
      horizonExpected: {
        a2uPaymentId: payment.a2uPaymentId,
        fromAddress: payment.a2uFromAddress,
        toAddress: payment.a2uToAddress,
        amount: payment.merchantAmount,
        preparedHash: payment.a2uPreparedTxHash,
        preparedSequence: payment.a2uPreparedSequence,
      },
      paymentId,
      merchantUid: payment.merchantUid,
    })
    const checkpointLookup = await findRefundCheckpointByPaymentId(paymentId)
    const checkpointState = checkpointLookup.state === "present" && checkpointLookup.checkpoint.paymentId !== paymentId
      ? "uncertain"
      : checkpointLookup.state
    const barrier = evaluateSettlementRefundCheckpointBarrier(checkpointState)
    const refundPiResult = await reconcileRefundAbsenceForPayment({
      paymentId,
      payerUid: payment.payerUid,
      amount: payment.customerAmount,
      a2uPaymentId: payment.a2uPaymentId,
    })
    const oppositeRefund = evaluateFinancialRecoverySettlementRefundOppositeBinding({
      checkpoint: barrier,
      refundPiOutcome: refundPiResult.outcome,
      refundBlockchainOutcome: null,
    })
    const preGate = evaluateFinancialRecoverySettlementSubmitReplayPreGate({
      payment,
      readResult,
      oppositeRefund,
      refundPiResult,
    })
    return evaluateFinancialRecoverySettlementSubmitReplayGate(preGate)
  } catch {
    return blocked()
  }
}
