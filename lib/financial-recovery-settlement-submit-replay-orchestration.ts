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
    !canonicalString(paymentId) ||
    payment.id !== paymentId ||
    !canonicalString(payment.merchantUid) ||
    !canonicalString(payment.payerUid) ||
    !canonicalString(payment.a2uPaymentId) ||
    !canonicalString(payment.a2uFromAddress) ||
    !canonicalString(payment.a2uToAddress) ||
    !canonicalString(payment.a2uPreparedEnvelopeXdr) ||
    !canonicalString(payment.a2uPreparedTxHash) ||
    !canonicalString(payment.a2uPreparedSequence) ||
    typeof payment.customerAmount !== "number" ||
    !Number.isFinite(payment.customerAmount) || payment.customerAmount <= 0 ||
    typeof payment.merchantAmount !== "number" ||
    !Number.isFinite(payment.merchantAmount) || payment.merchantAmount <= 0
  ) return blocked()

  const merchantUid = payment.merchantUid
  const payerUid = payment.payerUid
  const a2uPaymentId = payment.a2uPaymentId
  const fromAddress = payment.a2uFromAddress
  const toAddress = payment.a2uToAddress
  const envelopeXdr = payment.a2uPreparedEnvelopeXdr
  const preparedHash = payment.a2uPreparedTxHash
  const preparedSequence = payment.a2uPreparedSequence
  const customerAmount = payment.customerAmount
  const merchantAmount = payment.merchantAmount

  try {
    const readResult = await readFinancialRecoverySettlementSubmitEvidence({
      xdrInput: {
        a2uPaymentId: a2uPaymentId,
        fromAddress: fromAddress,
        toAddress: toAddress,
        amount: merchantAmount,
        envelopeXdr: envelopeXdr,
        preparedHash: preparedHash,
        preparedSequence: preparedSequence,
      },
      horizonExpected: {
        a2uPaymentId: a2uPaymentId,
        fromAddress: fromAddress,
        toAddress: toAddress,
        amount: merchantAmount,
        preparedHash: preparedHash,
        preparedSequence: preparedSequence,
      },
      paymentId,
      merchantUid: merchantUid,
    })
    const checkpointLookup = await findRefundCheckpointByPaymentId(paymentId)
    const checkpointState = checkpointLookup.state === "present" && checkpointLookup.checkpoint.paymentId !== paymentId
      ? "uncertain"
      : checkpointLookup.state
    const barrier = evaluateSettlementRefundCheckpointBarrier(checkpointState)
    const refundPiResult = await reconcileRefundAbsenceForPayment({
      paymentId,
      payerUid: payerUid,
      amount: customerAmount,
      a2uPaymentId: a2uPaymentId,
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
