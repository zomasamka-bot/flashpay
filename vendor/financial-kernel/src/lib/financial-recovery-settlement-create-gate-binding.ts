import {
  evaluateFinancialRecoverySettlementCreatePreGate,
  type FinancialRecoverySettlementCreatePreGateInput,
  type FinancialRecoverySettlementCreatePreGateResult,
} from "./financial-recovery-settlement-create-pre-gate"
import {
  evaluateFinancialRecoveryExactlyOnceGate,
  type ExactlyOnceGateResult,
} from "./financial-recovery-exactly-once-gate"

export type FinancialRecoverySettlementCreateGateBindingResult = Readonly<{
  authorizesFinancialAction: false
}> &
  (
    | Readonly<{
        outcome: "PRE_GATE_BLOCKED"
        reason: Extract<FinancialRecoverySettlementCreatePreGateResult, { outcome: "BLOCKED" }>["reason"]
      }>
    | Readonly<{
        outcome: "GATE_RESULT"
        gate: ExactlyOnceGateResult
      }>
  )

export function evaluateFinancialRecoverySettlementCreateGateBinding(
  input: FinancialRecoverySettlementCreatePreGateInput,
): FinancialRecoverySettlementCreateGateBindingResult {
  const preGate = evaluateFinancialRecoverySettlementCreatePreGate(input)
  if (preGate.outcome === "BLOCKED") {
    return { authorizesFinancialAction: false, outcome: "PRE_GATE_BLOCKED", reason: preGate.reason }
  }

  const gate = evaluateFinancialRecoveryExactlyOnceGate({
    operation: "SETTLEMENT_CREATE",
    decisionInput: preGate.decisionInput,
    oppositePaymentId: preGate.oppositePaymentId,
    oppositeTxid: preGate.oppositeTxid,
    oppositeMoneyMovement: preGate.oppositeMoneyMovement,
  })
  return { authorizesFinancialAction: false, outcome: "GATE_RESULT", gate }
}
