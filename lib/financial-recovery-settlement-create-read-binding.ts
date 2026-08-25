import {
  evaluateFinancialRecoveryU2AProof,
  type U2AInput,
} from "./financial-recovery-u2a-proof"
import {
  evaluateFinancialRecoverySettlementCreateGateBinding,
  type FinancialRecoverySettlementCreateGateBindingResult,
} from "./financial-recovery-settlement-create-gate-binding"
import type { SettlementCreatePiReadResult } from "./financial-recovery-settlement-create-pi-reader"
import type { FinancialRecoveryDecisionInput } from "./financial-recovery-decision"
import type { PaymentRefundCheckpointLookup } from "./refund-checkpoint-store"

export type FinancialRecoverySettlementCreateReadBindingInput = Readonly<{
  read: SettlementCreatePiReadResult
  decisionInput: FinancialRecoveryDecisionInput
  expected: Readonly<{
    paymentId: string
    piPaymentId: string
    u2aTxid: string
    amount: number
    payerUid: string
    merchantUid: string
  }>
  queriedPaymentId: string
  refundCheckpoint: PaymentRefundCheckpointLookup
}>

export type FinancialRecoverySettlementCreateReadBindingResult = Readonly<{
  authorizesFinancialAction: false
}> &
  (
    | Readonly<{ outcome: "BLOCKED"; reason: "READ_UNVERIFIED" | "EXPECTED_INVALID" | "PI_EVIDENCE_UNVERIFIED" }>
    | Readonly<{ outcome: "BOUND"; result: FinancialRecoverySettlementCreateGateBindingResult }>
  )

export function evaluateFinancialRecoverySettlementCreateReadBinding(
  input: FinancialRecoverySettlementCreateReadBindingInput,
): FinancialRecoverySettlementCreateReadBindingResult {
  if (input.read.outcome !== "READ") {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "READ_UNVERIFIED" }
  }

  const { paymentId, piPaymentId, u2aTxid, amount, payerUid, merchantUid } = input.expected
  if (
    !paymentId.trim() || paymentId !== paymentId.trim() ||
    !piPaymentId.trim() || piPaymentId !== piPaymentId.trim() ||
    !u2aTxid.trim() || u2aTxid !== u2aTxid.trim() ||
    !payerUid.trim() || payerUid !== payerUid.trim() ||
    !merchantUid.trim() || merchantUid !== merchantUid.trim() ||
    !Number.isFinite(amount) || amount <= 0 ||
    paymentId !== input.decisionInput.paymentId || paymentId !== input.queriedPaymentId
  ) {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "EXPECTED_INVALID" }
  }

  const u2a = evaluateFinancialRecoveryU2AProof({
    source: input.read.u2a.source,
    candidate: input.read.u2a.candidate,
    expected: { piPaymentId, paymentId, u2aTxid, amount, payerUid },
  } satisfies U2AInput)
  if (u2a.outcome !== "VERIFIED") {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "U2A_EVIDENCE_UNVERIFIED" }
  }

  const result = evaluateFinancialRecoverySettlementCreateGateBinding({
    decisionInput: input.decisionInput,
    u2a: { ...u2a, expected: { piPaymentId, paymentId, u2aTxid, amount, payerUid } },
    pi: {
      source: input.read.pi.source,
      candidates: input.read.pi.candidates,
      expected: { branch: "SETTLEMENT", paymentId, amount, merchantUid },
    },
    queriedPaymentId: input.queriedPaymentId,
    refundCheckpoint: input.refundCheckpoint,
    refundPiOutcome: "CONFIRMED_NONE",
    refundBlockchainOutcome: null,
  })
  return { authorizesFinancialAction: false, outcome: "BOUND", result }
}
