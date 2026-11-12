import { evaluateFinancialRecoveryA2UProof } from "./financial-recovery-a2u-proof"
import type { SettlementSubmitPiReadResult } from "./financial-recovery-settlement-submit-pi-reader"

export type SettlementSubmitPiProofBindingInput = Readonly<{
  piReadResult: SettlementSubmitPiReadResult
  expected: Readonly<{
    a2uPaymentId: string
    paymentId: string
    amount: number
    merchantUid: string
    fromAddress: string
    toAddress: string
  }>
}>

export type SettlementSubmitPiProofBindingResult = Readonly<
  | {
      outcome: "VERIFIED_IDENTITY"
      moneyMovementProven: false
      authorizesFinancialAction: false
      reference: Readonly<{
        a2uPaymentId: string
        paymentId: string
        merchantUid: string
        amount: number
        fromAddress: string
        toAddress: string
        txid: string | null
      }>
    }
  | {
      outcome: "BLOCKED"
      reference: null
      authorizesFinancialAction: false
    }
>

export function bindSettlementSubmitPiProof(
  input: SettlementSubmitPiProofBindingInput,
): SettlementSubmitPiProofBindingResult {
  const blocked = (): SettlementSubmitPiProofBindingResult => ({
    outcome: "BLOCKED",
    reference: null,
    authorizesFinancialAction: false,
  })

  if (input.piReadResult.outcome !== "READ" || input.piReadResult.a2uPaymentId !== input.expected.a2uPaymentId) {
    return blocked()
  }

  const proof = evaluateFinancialRecoveryA2UProof({
    source: input.piReadResult.source,
    candidate: input.piReadResult.candidate,
    expected: {
      a2uPaymentId: input.expected.a2uPaymentId,
      paymentId: input.expected.paymentId,
      amount: input.expected.amount,
      merchantUid: input.expected.merchantUid,
      appAddress: input.expected.fromAddress,
    },
  })

  if (
    proof.outcome !== "VERIFIED" ||
    proof.reference.a2uPaymentId !== input.expected.a2uPaymentId ||
    proof.reference.paymentId !== input.expected.paymentId ||
    proof.reference.amount !== input.expected.amount ||
    proof.reference.merchantUid !== input.expected.merchantUid ||
    proof.reference.fromAddress !== input.expected.fromAddress ||
    proof.reference.toAddress !== input.expected.toAddress
  ) {
    return blocked()
  }

  return {
    outcome: "VERIFIED_IDENTITY",
    moneyMovementProven: false,
    authorizesFinancialAction: false,
    reference: proof.reference,
  }
}
