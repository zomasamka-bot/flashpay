import type { SettlementSubmitPiReadResult } from "./financial-recovery-settlement-submit-pi-reader"
import type { SettlementSubmitPiProofBindingResult } from "./financial-recovery-settlement-submit-pi-proof-binding"

export type SettlementSubmitPiTransferBlockerResult = Readonly<
  | {
      outcome: "NO_TRANSFER_EVIDENCE"
      moneyMovementProven: false
      authorizesFinancialAction: false
    }
  | {
      outcome: "BLOCKED"
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
    moneyMovementProven: false,
    authorizesFinancialAction: false,
  }
}
