import type { FinancialRecoverySettlementSubmitReplayPreGateResult } from "./financial-recovery-settlement-submit-replay-pre-gate"

type EligibleExactReplayResult = Extract<
  FinancialRecoverySettlementSubmitReplayPreGateResult,
  { outcome: "ELIGIBLE_EXACT_REPLAY" }
>

export type FinancialRecoverySettlementSubmitReplayGateResult =
  | Readonly<{
      outcome: "ALLOW_EXACT_REPLAY"
      reference: EligibleExactReplayResult["reference"]
      mode: "EXACT_STORED_XDR_ONLY"
      moneyMovementProven: false
      authorizesFinancialAction: true
    }>
  | Readonly<{
      outcome: "BLOCKED"
      reference: null
      mode: null
      moneyMovementProven: false
      authorizesFinancialAction: false
    }>

export function evaluateFinancialRecoverySettlementSubmitReplayGate(
  input: FinancialRecoverySettlementSubmitReplayPreGateResult,
): FinancialRecoverySettlementSubmitReplayGateResult {
  if (input.outcome !== "ELIGIBLE_EXACT_REPLAY") {
    return {
      outcome: "BLOCKED",
      reference: null,
      mode: null,
      moneyMovementProven: false,
      authorizesFinancialAction: false,
    }
  }

  return {
    outcome: "ALLOW_EXACT_REPLAY",
    reference: input.reference,
    mode: "EXACT_STORED_XDR_ONLY",
    moneyMovementProven: false,
    authorizesFinancialAction: true,
  }
}
