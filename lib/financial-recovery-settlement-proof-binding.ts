import type { A2UProofResult } from "./financial-recovery-a2u-proof"
import type { HorizonProofResult } from "./financial-recovery-horizon-proof"

export type SettlementProofBindingResult = Readonly<
  { authorizesFinancialAction: false } & (
    | {
        outcome: "VERIFIED"
        proof: "horizon_tx_exact"
        moneyMovementProven: true
        reference: Readonly<{
          paymentId: string
          merchantUid: string
          a2uPaymentId: string
          txid: string
          fromAddress: string
          toAddress: string
          amount: number
        }>
      }
    | {
        outcome: "INDETERMINATE"
        reason: "A2U_PROOF_UNVERIFIED" | "HORIZON_PROOF_UNVERIFIED" | "REFERENCE_MISMATCH"
      }
  )
>

export function bindFinancialRecoverySettlementProof(
  a2u: A2UProofResult,
  horizon: HorizonProofResult,
): SettlementProofBindingResult {
  if (a2u.outcome !== "VERIFIED") {
    return { authorizesFinancialAction: false, outcome: "INDETERMINATE", reason: "A2U_PROOF_UNVERIFIED" }
  }
  if (horizon.outcome !== "VERIFIED") {
    return { authorizesFinancialAction: false, outcome: "INDETERMINATE", reason: "HORIZON_PROOF_UNVERIFIED" }
  }
  const a2uReference = a2u.reference
  const horizonReference = horizon.reference
  if (
    a2uReference.a2uPaymentId !== horizonReference.a2uPaymentId ||
    a2uReference.fromAddress !== horizonReference.fromAddress ||
    a2uReference.toAddress !== horizonReference.toAddress ||
    a2uReference.amount !== horizonReference.amount ||
    (a2uReference.txid !== null && a2uReference.txid !== horizonReference.txid)
  ) {
    return { authorizesFinancialAction: false, outcome: "INDETERMINATE", reason: "REFERENCE_MISMATCH" }
  }
  return {
    authorizesFinancialAction: false,
    outcome: "VERIFIED",
    proof: "horizon_tx_exact",
    moneyMovementProven: true,
    reference: {
      paymentId: a2uReference.paymentId,
      merchantUid: a2uReference.merchantUid,
      a2uPaymentId: horizonReference.a2uPaymentId,
      txid: horizonReference.txid,
      fromAddress: horizonReference.fromAddress,
      toAddress: horizonReference.toAddress,
      amount: horizonReference.amount,
    },
  }
}
