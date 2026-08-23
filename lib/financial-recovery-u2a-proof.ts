export type U2AInput = Readonly<{
  source: "PI_PAYMENT_GET" | null
  candidate: unknown
  expected: Readonly<{
    piPaymentId: string
    paymentId: string
    u2aTxid: string
    amount: number
    payerUid: string
  }>
}>

export type U2AResult = Readonly<
  { authorizesFinancialAction: false } & (
    | { outcome: "VERIFIED" }
    | {
        outcome: "INDETERMINATE"
        reason: "INVALID_INPUT" | "NON_AUTHORITATIVE_SOURCE" | "MALFORMED_OR_MISMATCH"
      }
  )
>

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalid(reason: "INVALID_INPUT" | "NON_AUTHORITATIVE_SOURCE" | "MALFORMED_OR_MISMATCH"): U2AResult {
  return { authorizesFinancialAction: false, outcome: "INDETERMINATE", reason }
}

export function evaluateFinancialRecoveryU2AProof(input: U2AInput): U2AResult {
  if (input.source !== "PI_PAYMENT_GET") return invalid("NON_AUTHORITATIVE_SOURCE")

  const { piPaymentId, paymentId, u2aTxid, payerUid, amount } = input.expected
  if (
    !piPaymentId.trim() ||
    !paymentId.trim() ||
    !u2aTxid.trim() ||
    !payerUid.trim() ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) return invalid("INVALID_INPUT")

  if (!isRecord(input.candidate)) return invalid("MALFORMED_OR_MISMATCH")
  const candidate = input.candidate
  if (!isRecord(candidate.metadata) || !isRecord(candidate.status) || !isRecord(candidate.transaction)) {
    return invalid("MALFORMED_OR_MISMATCH")
  }

  const metadata = candidate.metadata
  const status = candidate.status
  const transaction = candidate.transaction
  const identifier = candidate.identifier
  const userUid = candidate.user_uid
  const user = candidate.user
  const nestedUid = isRecord(user) ? user.uid : undefined

  if (
    identifier !== piPaymentId ||
    metadata.paymentId !== paymentId ||
    candidate.direction !== "user_to_app" ||
    candidate.amount !== amount ||
    transaction.txid !== u2aTxid ||
    candidate.developer_approved !== true ||
    status.transaction_verified !== true ||
    status.developer_completed !== true ||
    (candidate.cancelled !== undefined && candidate.cancelled !== false) ||
    (candidate.user_cancelled !== undefined && candidate.user_cancelled !== false)
  ) return invalid("MALFORMED_OR_MISMATCH")

  if (userUid !== undefined && (typeof userUid !== "string" || userUid !== payerUid)) {
    return invalid("MALFORMED_OR_MISMATCH")
  }
  if (nestedUid !== undefined && (typeof nestedUid !== "string" || nestedUid !== payerUid)) {
    return invalid("MALFORMED_OR_MISMATCH")
  }
  if (userUid !== undefined && nestedUid !== undefined && userUid !== nestedUid) {
    return invalid("MALFORMED_OR_MISMATCH")
  }
  if (userUid === undefined && nestedUid === undefined) return invalid("MALFORMED_OR_MISMATCH")

  return { authorizesFinancialAction: false, outcome: "VERIFIED" }
}
