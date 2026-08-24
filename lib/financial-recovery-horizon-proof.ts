export type HorizonProofInput = Readonly<{
  source: "HORIZON_TX_OPS" | null
  transaction: unknown
  operations: unknown
  expected: Readonly<{
    txid: string
    a2uPaymentId: string
    fromAddress: string
    toAddress: string
    amount: number
  }>
}>

export type HorizonProofResult = Readonly<
  { authorizesFinancialAction: false } &
    (
      | {
          outcome: "VERIFIED"
          proof: "horizon_tx_exact"
          moneyMovementProven: true
          reference: Readonly<{
            txid: string
            a2uPaymentId: string
            fromAddress: string
            toAddress: string
            amount: number
          }>
        }
      | {
          outcome: "INDETERMINATE"
          reason: "INVALID_INPUT" | "NON_AUTHORITATIVE_SOURCE" | "MALFORMED_OR_MISMATCH"
        }
    )
>

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function evaluateFinancialRecoveryHorizonProof(input: HorizonProofInput): HorizonProofResult {
  const indeterminate = (
    reason: "INVALID_INPUT" | "NON_AUTHORITATIVE_SOURCE" | "MALFORMED_OR_MISMATCH",
  ): HorizonProofResult => ({ authorizesFinancialAction: false, outcome: "INDETERMINATE", reason })

  if (input.source !== "HORIZON_TX_OPS") return indeterminate("NON_AUTHORITATIVE_SOURCE")

  const { txid, a2uPaymentId, fromAddress, toAddress, amount } = input.expected
  if (
    !txid.trim() ||
    !a2uPaymentId.trim() ||
    !fromAddress.trim() ||
    !toAddress.trim() ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return indeterminate("INVALID_INPUT")
  }

  if (!isRecord(input.transaction) || !Array.isArray(input.operations) || input.operations.length !== 1) {
    return indeterminate("MALFORMED_OR_MISMATCH")
  }

  const transaction = input.transaction
  const operation = input.operations[0]
  if (!isRecord(operation)) return indeterminate("MALFORMED_OR_MISMATCH")

  if (
    transaction.hash !== txid ||
    transaction.successful !== true ||
    transaction.source_account !== fromAddress ||
    transaction.memo_type !== "text" ||
    transaction.memo !== a2uPaymentId.substring(0, 28) ||
    transaction.operation_count !== 1 ||
    operation.type !== "payment" ||
    operation.transaction_hash !== txid ||
    operation.transaction_successful !== true ||
    operation.from !== fromAddress ||
    operation.to !== toAddress ||
    operation.asset_type !== "native" ||
    !Number.isFinite(Number(operation.amount)) ||
    Number(operation.amount) !== amount
  ) {
    return indeterminate("MALFORMED_OR_MISMATCH")
  }

  return {
    authorizesFinancialAction: false,
    outcome: "VERIFIED",
    proof: "horizon_tx_exact",
    moneyMovementProven: true,
    reference: { txid, a2uPaymentId, fromAddress, toAddress, amount },
  }
}
