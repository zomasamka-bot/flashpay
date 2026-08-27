import "server-only"

import { readSettlementSubmitHorizonEvidence } from "./financial-recovery-settlement-submit-horizon-reader"
import { evaluateFinancialRecoverySettlementSubmitEvidenceBinding } from "./financial-recovery-settlement-submit-evidence-binding"
import type { FinancialRecoverySettlementSubmitEvidenceBindingResult } from "./financial-recovery-settlement-submit-evidence-binding"
import { classifyFinancialRecoverySettlementSubmitSequence } from "./financial-recovery-settlement-submit-sequence-classifier"
import type { SettlementSubmitXdrVerifierInput } from "./financial-recovery-settlement-submit-xdr-verifier"
import type { SettlementSubmitHorizonBindingInput } from "./financial-recovery-settlement-submit-horizon-binding"

export type FinancialRecoverySettlementSubmitReadOrchestrationInput = Readonly<{
  xdrInput: SettlementSubmitXdrVerifierInput
  horizonExpected: SettlementSubmitHorizonBindingInput["expected"]
}>

export type FinancialRecoverySettlementSubmitReadOrchestrationResult =
  | FinancialRecoverySettlementSubmitEvidenceBindingResult
  | ReturnType<typeof classifyFinancialRecoverySettlementSubmitSequence>

export async function readFinancialRecoverySettlementSubmitEvidence(
  input: FinancialRecoverySettlementSubmitReadOrchestrationInput,
): Promise<FinancialRecoverySettlementSubmitReadOrchestrationResult> {
  try {
    const read = await readSettlementSubmitHorizonEvidence(
      input.horizonExpected.preparedHash,
      input.horizonExpected.preparedSequence,
      input.horizonExpected.fromAddress,
    )
    const binding = evaluateFinancialRecoverySettlementSubmitEvidenceBinding({
      xdrInput: input.xdrInput,
      horizonInput: { read, expected: input.horizonExpected },
    })
    if (binding.outcome === "MOVEMENT_VERIFIED") return binding
    return classifyFinancialRecoverySettlementSubmitSequence(binding)
  } catch {
    return {
      outcome: "BLOCKED",
      reference: null,
      moneyMovementProven: false,
      authorizesFinancialAction: false,
    }
  }
}
