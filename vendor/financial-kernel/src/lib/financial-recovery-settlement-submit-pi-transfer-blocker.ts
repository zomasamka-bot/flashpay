import type { SettlementSubmitPiReadResult } from "./financial-recovery-settlement-submit-pi-reader"
import type { SettlementSubmitPiProofBindingResult } from "./financial-recovery-settlement-submit-pi-proof-binding"

type VerifiedIdentityResult = Extract<SettlementSubmitPiProofBindingResult, { outcome: "VERIFIED_IDENTITY" }>

export type SettlementSubmitPiTransferBlockerResult = Readonly<
  | {
      outcome: "NO_TRANSFER_EVIDENCE"
      reference: VerifiedIdentityResult["reference"]
      moneyMovementProven: false
      authorizesFinancialAction: false
    }
  | {
      outcome: "BLOCKED"
      reference: null
      authorizesFinancialAction: false
    }
>

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function blockSettlementSubmitPiTransfer(
  piReadResult: SettlementSubmitPiReadResult,
  proofResult: SettlementSubmitPiProofBindingResult,
): SettlementSubmitPiTransferBlockerResult {
  const blocked = (): SettlementSubmitPiTransferBlockerResult => ({
    outcome: "BLOCKED",
    reference: null,
    authorizesFinancialAction: false,
  })

  if (proofResult.outcome !== "VERIFIED_IDENTITY" || piReadResult.outcome !== "READ") {
    return blocked()
  }

  if (proofResult.reference.a2uPaymentId !== piReadResult.a2uPaymentId) {
    return blocked()
  }

  if (!isRecord(piReadResult.candidate) || !isRecord(piReadResult.candidate.status)) {
    return blocked()
  }

  if (
    piReadResult.candidate.status.transaction_verified !== false ||
    piReadResult.candidate.status.developer_completed !== false ||
    piReadResult.candidate.status.cancelled !== false ||
    piReadResult.candidate.status.user_cancelled !== false ||
    piReadResult.candidate.transaction !== null
  ) {
    return blocked()
  }

  return {
    outcome: "NO_TRANSFER_EVIDENCE",
    reference: proofResult.reference,
    moneyMovementProven: false,
    authorizesFinancialAction: false,
  }
}
