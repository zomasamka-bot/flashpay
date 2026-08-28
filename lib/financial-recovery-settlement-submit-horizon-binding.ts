import type { SettlementSubmitHorizonReadResult } from "./financial-recovery-settlement-submit-horizon-reader"
import { evaluateFinancialRecoveryHorizonProof } from "./financial-recovery-horizon-proof"

export type SettlementSubmitHorizonBindingInput = Readonly<{
  read: SettlementSubmitHorizonReadResult
  expected: Readonly<{
    preparedHash: string
    preparedSequence: string
    a2uPaymentId: string
    fromAddress: string
    toAddress: string
    amount: number
  }>
}>

export type SettlementSubmitHorizonBindingResult = Readonly<
  { authorizesFinancialAction: false } &
    (
      | {
          outcome: "VERIFIED"
          proof: "horizon_tx_exact"
          moneyMovementProven: true
          preparedHash: string
          preparedSequence: string
          a2uPaymentId: string
          fromAddress: string
          toAddress: string
          amount: number
          horizonFeeCharged: number
        }
      | { outcome: "UNRESOLVED"; observedSourceSequence: string }
      | { outcome: "BLOCKED" }
    )
>

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function evaluateFinancialRecoverySettlementSubmitHorizonBinding(
  input: SettlementSubmitHorizonBindingInput,
): SettlementSubmitHorizonBindingResult {
  const { preparedHash, preparedSequence, a2uPaymentId, fromAddress, toAddress, amount } = input.expected
  if (
    !/^[0-9a-f]{64}$/.test(preparedHash) ||
    !/^[1-9][0-9]*$/.test(preparedSequence) ||
    !a2uPaymentId.trim() || a2uPaymentId !== a2uPaymentId.trim() ||
    !fromAddress.trim() || fromAddress !== fromAddress.trim() ||
    !toAddress.trim() || toAddress !== toAddress.trim() ||
    !Number.isFinite(amount) || amount <= 0
  ) return { authorizesFinancialAction: false, outcome: "BLOCKED" }

  if (input.read.outcome === "INDETERMINATE") return { authorizesFinancialAction: false, outcome: "BLOCKED" }
  if (
    input.read.preparedHash !== preparedHash ||
    input.read.preparedSequence !== preparedSequence ||
    input.read.fromAddress !== fromAddress
  ) return { authorizesFinancialAction: false, outcome: "BLOCKED" }
  if (input.read.outcome === "HASH_NOT_FOUND") {
    return { authorizesFinancialAction: false, outcome: "UNRESOLVED", observedSourceSequence: input.read.observedSourceSequence }
  }

  if (
    !isRecord(input.read.transaction) ||
    typeof input.read.transaction.source_account_sequence !== "string" ||
    input.read.transaction.source_account_sequence !== preparedSequence
  ) return { authorizesFinancialAction: false, outcome: "BLOCKED" }

  if (
    (typeof input.read.transaction.fee_charged !== "number" && typeof input.read.transaction.fee_charged !== "string") ||
    !Number.isFinite(Number(input.read.transaction.fee_charged)) ||
    Number(input.read.transaction.fee_charged) < 0
  ) return { authorizesFinancialAction: false, outcome: "BLOCKED" }
  const feeChargedStroops = Number(input.read.transaction.fee_charged)
  const horizonFeeCharged = feeChargedStroops / 10_000_000

  const proof = evaluateFinancialRecoveryHorizonProof({
    source: input.read.source,
    transaction: input.read.transaction,
    operations: input.read.operations,
    expected: { txid: preparedHash, a2uPaymentId, fromAddress, toAddress, amount },
  })
  if (proof.outcome !== "VERIFIED") return { authorizesFinancialAction: false, outcome: "BLOCKED" }
  return {
    authorizesFinancialAction: false,
    outcome: "VERIFIED",
    proof: "horizon_tx_exact",
    moneyMovementProven: true,
    preparedHash,
    preparedSequence,
    a2uPaymentId,
    fromAddress,
    toAddress,
    amount,
    horizonFeeCharged,
  }
}
