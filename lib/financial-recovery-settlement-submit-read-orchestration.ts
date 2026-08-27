import "server-only"

import { readSettlementSubmitPiEvidence } from "./financial-recovery-settlement-submit-pi-reader"
import { bindSettlementSubmitPiProof } from "./financial-recovery-settlement-submit-pi-proof-binding"
import { blockSettlementSubmitPiTransfer } from "./financial-recovery-settlement-submit-pi-transfer-blocker"
import { readSettlementSubmitHorizonEvidence } from "./financial-recovery-settlement-submit-horizon-reader"
import { evaluateFinancialRecoverySettlementSubmitEvidenceBinding } from "./financial-recovery-settlement-submit-evidence-binding"
import type { FinancialRecoverySettlementSubmitEvidenceBindingResult } from "./financial-recovery-settlement-submit-evidence-binding"
import { classifyFinancialRecoverySettlementSubmitSequence } from "./financial-recovery-settlement-submit-sequence-classifier"
import type { SettlementSubmitXdrVerifierInput } from "./financial-recovery-settlement-submit-xdr-verifier"
import type { SettlementSubmitHorizonBindingInput } from "./financial-recovery-settlement-submit-horizon-binding"

export type FinancialRecoverySettlementSubmitReadOrchestrationInput = Readonly<{
  xdrInput: SettlementSubmitXdrVerifierInput
  horizonExpected: SettlementSubmitHorizonBindingInput["expected"]
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
    const piReadResult = await readSettlementSubmitPiEvidence(input.horizonExpected.a2uPaymentId)
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
    const piProof = bindSettlementSubmitPiProof({
      piReadResult,
      expected: {
        a2uPaymentId: input.horizonExpected.a2uPaymentId,
        paymentId: input.paymentId,
        amount: input.horizonExpected.amount,
        merchantUid: input.merchantUid,
        fromAddress: input.horizonExpected.fromAddress,
        toAddress: input.horizonExpected.toAddress,
      },
    })
    const piTransferResult = blockSettlementSubmitPiTransfer(piReadResult, piProof)
    if (
      piTransferResult.outcome !== "NO_TRANSFER_EVIDENCE" ||
      classified.outcome === "BLOCKED" ||
      piTransferResult.reference.a2uPaymentId !== classified.reference.a2uPaymentId ||
      piTransferResult.reference.fromAddress !== classified.reference.fromAddress ||
      piTransferResult.reference.toAddress !== classified.reference.toAddress ||
      piTransferResult.reference.amount !== classified.reference.amount
    ) return {
      outcome: "BLOCKED",
      reference: null,
      moneyMovementProven: false,
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
