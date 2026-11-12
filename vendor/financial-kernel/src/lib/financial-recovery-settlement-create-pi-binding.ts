import type { FinancialRecoveryDecisionInput } from "./financial-recovery-decision"
import { evaluateFinancialRecoveryPiCandidates, type FinancialRecoveryPiExpectation } from "./financial-recovery-pi-candidate-rules"

export type SettlementCreateBindingInput = Readonly<{
  decisionInput: FinancialRecoveryDecisionInput
  pi: Readonly<{
    source: "PI_INCOMPLETE_SERVER_PAYMENTS" | null
    candidates: unknown
    expected: Extract<FinancialRecoveryPiExpectation, { branch: "SETTLEMENT" }>
  }>
}>

export type SettlementCreateBindingResult = Readonly<
  { authorizesFinancialAction: false } & (
    | { outcome: "BOUND"; decisionInput: FinancialRecoveryDecisionInput }
    | {
        outcome: "BLOCKED"
        reason: "PAYMENT_ID_MISMATCH" | "TARGET_STATE_MISMATCH" | "PI_EVIDENCE_UNVERIFIED"
      }
  )
>

export function bindSettlementCreatePiToDecision(input: SettlementCreateBindingInput): SettlementCreateBindingResult {
  const paymentId = input.decisionInput.paymentId
  const expectedPaymentId = input.pi.expected.paymentId
  if (
    paymentId.trim() === "" ||
    paymentId !== paymentId.trim() ||
    expectedPaymentId.trim() === "" ||
    expectedPaymentId !== expectedPaymentId.trim() ||
    paymentId !== expectedPaymentId
  ) {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PAYMENT_ID_MISMATCH" }
  }
  if (input.decisionInput.targetState !== "settlement_created") {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "TARGET_STATE_MISMATCH" }
  }
  const evaluation = evaluateFinancialRecoveryPiCandidates(input.pi)
  if (evaluation.outcome === "INDETERMINATE") {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PI_EVIDENCE_UNVERIFIED" }
  }
  return {
    authorizesFinancialAction: false,
    outcome: "BOUND",
    decisionInput: {
      ...input.decisionInput,
      reconciliationOutcome: evaluation.outcome,
      reconciliationSource: "PI_PAYMENT",
      targetPaymentIdPresent: evaluation.outcome === "FOUND",
    },
  }
}
