export type A2UProofInput = Readonly<{
  source: "PI_PAYMENT_GET" | null
  candidate: unknown
  expected: Readonly<{
    a2uPaymentId: string
    paymentId: string
    amount: number
    merchantUid: string
    appAddress: string
  }>
}>

export type A2UProofResult = Readonly<
  { authorizesFinancialAction: false } & (
    | {
        outcome: "VERIFIED"
        moneyMovementProven: false
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
        outcome: "INDETERMINATE"
        reason: "INVALID_INPUT" | "NON_AUTHORITATIVE_SOURCE" | "MALFORMED_OR_MISMATCH"
      }
  )
>

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function evaluateFinancialRecoveryA2UProof(input: A2UProofInput): A2UProofResult {
  const indeterminate = (reason: "INVALID_INPUT" | "NON_AUTHORITATIVE_SOURCE" | "MALFORMED_OR_MISMATCH"): A2UProofResult => ({
    authorizesFinancialAction: false,
    outcome: "INDETERMINATE",
    reason,
  })
  if (input.source !== "PI_PAYMENT_GET") return indeterminate("NON_AUTHORITATIVE_SOURCE")
  const expected = input.expected
  if (
    !expected.a2uPaymentId.trim() ||
    !expected.paymentId.trim() ||
    !expected.merchantUid.trim() ||
    !expected.appAddress.trim() ||
    !Number.isFinite(expected.amount) ||
    expected.amount <= 0
  ) return indeterminate("INVALID_INPUT")
  if (!isRecord(input.candidate)) return indeterminate("MALFORMED_OR_MISMATCH")
  const candidate = input.candidate
  const metadata = candidate.metadata
  if (!isRecord(metadata)) return indeterminate("MALFORMED_OR_MISMATCH")
  const toAddress = candidate.to_address
  if (typeof toAddress !== "string" || !toAddress.trim()) return indeterminate("MALFORMED_OR_MISMATCH")
  if (
    candidate.identifier !== expected.a2uPaymentId ||
    metadata.type !== "a2u_settlement" ||
    metadata.paymentId !== expected.paymentId ||
    candidate.direction !== "app_to_user" ||
    candidate.amount !== expected.amount ||
    candidate.user_uid !== expected.merchantUid ||
    candidate.from_address !== expected.appAddress ||
  ) return indeterminate("MALFORMED_OR_MISMATCH")

  const status = candidate.status
  if (status !== undefined && status !== null && !isRecord(status)) return indeterminate("MALFORMED_OR_MISMATCH")
  if (isRecord(status) && (status.cancelled !== undefined && status.cancelled !== false || status.user_cancelled !== undefined && status.user_cancelled !== false)) {
    return indeterminate("MALFORMED_OR_MISMATCH")
  }

  const transaction = candidate.transaction
  if (transaction !== undefined && transaction !== null && !isRecord(transaction)) return indeterminate("MALFORMED_OR_MISMATCH")
  if (isRecord(transaction) && transaction.txid !== undefined && (typeof transaction.txid !== "string" || !transaction.txid.trim())) {
    return indeterminate("MALFORMED_OR_MISMATCH")
  }

  return {
    authorizesFinancialAction: false,
    outcome: "VERIFIED",
    moneyMovementProven: false,
    reference: {
      a2uPaymentId: expected.a2uPaymentId,
      paymentId: expected.paymentId,
      merchantUid: expected.merchantUid,
      amount: expected.amount,
      fromAddress: expected.appAddress,
      toAddress,
      txid: isRecord(transaction) && typeof transaction.txid === "string" ? transaction.txid : null,
    },
  }
}
