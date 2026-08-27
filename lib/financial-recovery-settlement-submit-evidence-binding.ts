import { verifySettlementSubmitXdrIntent } from "./financial-recovery-settlement-submit-xdr-verifier"
import type { SettlementSubmitXdrVerifierInput } from "./financial-recovery-settlement-submit-xdr-verifier"
import { evaluateFinancialRecoverySettlementSubmitHorizonBinding } from "./financial-recovery-settlement-submit-horizon-binding"
import type { SettlementSubmitHorizonBindingInput } from "./financial-recovery-settlement-submit-horizon-binding"

export type FinancialRecoverySettlementSubmitEvidenceBindingInput = Readonly<{
  xdrInput: SettlementSubmitXdrVerifierInput
  horizonInput: SettlementSubmitHorizonBindingInput
}>

export type FinancialRecoverySettlementSubmitEvidenceBindingResult = Readonly<
  | {
      authorizesFinancialAction: false
      outcome: "BLOCKED"
    }
  | {
      authorizesFinancialAction: false
      outcome: "MOVEMENT_VERIFIED"
      reference: NonNullable<Extract<ReturnType<typeof verifySettlementSubmitXdrIntent>, { outcome: "VERIFIED_INTENT" }>["reference"]>
      proof: "horizon_tx_exact"
      moneyMovementProven: true
    }
  | {
      authorizesFinancialAction: false
      outcome: "UNRESOLVED"
      reference: NonNullable<Extract<ReturnType<typeof verifySettlementSubmitXdrIntent>, { outcome: "VERIFIED_INTENT" }>["reference"]>
      observedSourceSequence: string
      moneyMovementProven: false
    }
>

export function evaluateFinancialRecoverySettlementSubmitEvidenceBinding(
  input: FinancialRecoverySettlementSubmitEvidenceBindingInput,
): FinancialRecoverySettlementSubmitEvidenceBindingResult {
  try {
    const xdrResult = verifySettlementSubmitXdrIntent(input.xdrInput)
    if (xdrResult.outcome !== "VERIFIED_INTENT") return { authorizesFinancialAction: false, outcome: "BLOCKED" }

    const reference = xdrResult.reference
    const expected = input.horizonInput.expected
    if (
      reference.preparedHash !== expected.preparedHash ||
      reference.preparedSequence !== expected.preparedSequence ||
      reference.a2uPaymentId !== expected.a2uPaymentId ||
      reference.fromAddress !== expected.fromAddress ||
      reference.toAddress !== expected.toAddress ||
      reference.amount !== expected.amount
    ) return { authorizesFinancialAction: false, outcome: "BLOCKED" }

    const horizonResult = evaluateFinancialRecoverySettlementSubmitHorizonBinding(input.horizonInput)
    if (horizonResult.outcome === "BLOCKED") return { authorizesFinancialAction: false, outcome: "BLOCKED" }
    if (horizonResult.outcome === "UNRESOLVED") {
      return {
        authorizesFinancialAction: false,
        outcome: "UNRESOLVED",
        reference,
        observedSourceSequence: horizonResult.observedSourceSequence,
        moneyMovementProven: false,
      }
    }
    if (
      horizonResult.preparedHash !== reference.preparedHash ||
      horizonResult.preparedSequence !== reference.preparedSequence ||
      horizonResult.a2uPaymentId !== reference.a2uPaymentId ||
      horizonResult.fromAddress !== reference.fromAddress ||
      horizonResult.toAddress !== reference.toAddress ||
      horizonResult.amount !== reference.amount
    ) return { authorizesFinancialAction: false, outcome: "BLOCKED" }
    return { authorizesFinancialAction: false, outcome: "MOVEMENT_VERIFIED", reference, proof: "horizon_tx_exact", moneyMovementProven: true }
  } catch {
    return { authorizesFinancialAction: false, outcome: "BLOCKED" }
  }
}
