import "server-only"

import { readSettlementSubmitHorizonEvidence } from "./financial-recovery-settlement-submit-horizon-reader"
import { evaluateFinancialRecoverySettlementSubmitEvidenceBinding } from "./financial-recovery-settlement-submit-evidence-binding"
import type { FinancialRecoverySettlementSubmitEvidenceBindingResult } from "./financial-recovery-settlement-submit-evidence-binding"
import { classifyFinancialRecoverySettlementSubmitSequence } from "./financial-recovery-settlement-submit-sequence-classifier"
import type { SettlementSubmitXdrVerifierInput } from "./financial-recovery-settlement-submit-xdr-verifier"
import type { SettlementSubmitHorizonBindingInput } from "./financial-recovery-settlement-submit-horizon-binding"
import type { SettlementSubmitPiTransferBlockerResult } from "./financial-recovery-settlement-submit-pi-transfer-blocker"

export type FinancialRecoverySettlementSubmitReadOrchestrationInput = Readonly<{
  xdrInput: SettlementSubmitXdrVerifierInput
  horizonExpected: SettlementSubmitHorizonBindingInput["expected"]
  piTransferResult: SettlementSubmitPiTransferBlockerResult
  paymentId: string
  merchantUid: string
}>

export type FinancialRecoverySettlementSubmitReadOrchestrationResult =
  | Extract<FinancialRecoverySettlementSubmitEvidenceBindingResult, { outcome: "MOVEMENT_VERIFIED" }>
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
    const classified = classifyFinancialRecoverySettlementSubmitSequence(binding)
    if (
      input.piTransferResult.outcome !== "NO_TRANSFER_EVIDENCE" ||
      classified.outcome === "BLOCKED" ||
      input.piTransferResult.reference.paymentId !== input.paymentId ||
      input.piTransferResult.reference.merchantUid !== input.merchantUid ||
      classified.reference.a2uPaymentId !== input.horizonExpected.a2uPaymentId ||
      classified.reference.fromAddress !== input.horizonExpected.fromAddress ||
      classified.reference.toAddress !== input.horizonExpected.toAddress ||
      classified.reference.amount !== input.horizonExpected.amount
    ) return {
      outcome: "BLOCKED",
      reference: null,
      authorizesFinancialAction: false,
    }
    return classified
  } catch {
    return {
      outcome: "BLOCKED",
      reference: null,
      moneyMovementProven: false,
      authorizesFinancialAction: false,
    }
  }
}
