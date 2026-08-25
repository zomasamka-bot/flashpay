import type { FinancialRecoveryDecisionInput } from "./financial-recovery-decision"
import type { FinancialRecoveryPiExpectation } from "./financial-recovery-pi-candidate-rules"

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
