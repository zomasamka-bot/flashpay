import * as StellarSDK from "@stellar/stellar-sdk"

export type SettlementSubmitXdrVerifierInput = Readonly<{
  envelopeXdr: string
  preparedHash: string
  preparedSequence: string
  a2uPaymentId: string
  fromAddress: string
  toAddress: string
  amount: number
}>

export type SettlementSubmitXdrIntentReference = Readonly<{
  envelopeXdr: string
  preparedHash: string
  preparedSequence: string
  a2uPaymentId: string
  fromAddress: string
  toAddress: string
  amount: number
}>

export type SettlementSubmitXdrVerifierResult = Readonly<
  | {
      outcome: "VERIFIED_INTENT"
      reference: SettlementSubmitXdrIntentReference
      moneyMovementProven: false
      authorizesFinancialAction: false
    }
  | {
      outcome: "BLOCKED"
      reason: "INVALID_INPUT" | "XDR_INVALID" | "INTENT_MISMATCH" | "SIGNATURE_INVALID"
      reference: null
      moneyMovementProven: false
      authorizesFinancialAction: false
    }
>

const blocked = (reason: "INVALID_INPUT" | "XDR_INVALID" | "INTENT_MISMATCH" | "SIGNATURE_INVALID"): SettlementSubmitXdrVerifierResult => ({
  outcome: "BLOCKED",
  reason,
  reference: null,
  moneyMovementProven: false,
  authorizesFinancialAction: false,
})

export function verifySettlementSubmitXdrIntent(input: SettlementSubmitXdrVerifierInput): SettlementSubmitXdrVerifierResult {
  if (
    typeof input.envelopeXdr !== "string" || !input.envelopeXdr.trim() || input.envelopeXdr !== input.envelopeXdr.trim() ||
    !/^[0-9a-f]{64}$/.test(input.preparedHash) ||
    !/^[1-9][0-9]*$/.test(input.preparedSequence) ||
    typeof input.a2uPaymentId !== "string" || !input.a2uPaymentId.trim() || input.a2uPaymentId !== input.a2uPaymentId.trim() ||
    typeof input.fromAddress !== "string" || !input.fromAddress.trim() || input.fromAddress !== input.fromAddress.trim() ||
    typeof input.toAddress !== "string" || !input.toAddress.trim() || input.toAddress !== input.toAddress.trim() ||
    typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount <= 0
  ) return blocked("INVALID_INPUT")

  let transaction: StellarSDK.Transaction
  try {
    const parsed = StellarSDK.TransactionBuilder.fromXDR(input.envelopeXdr, "Pi Testnet")
    if (!(parsed instanceof StellarSDK.Transaction)) return blocked("XDR_INVALID")
    transaction = parsed
  } catch {
    return blocked("XDR_INVALID")
  }

  try {
    if (transaction.toXDR() !== input.envelopeXdr || transaction.hash().toString("hex") !== input.preparedHash || transaction.sequence !== input.preparedSequence || transaction.source !== input.fromAddress) return blocked("INTENT_MISMATCH")
    if (transaction.operations.length !== 1 || transaction.signatures.length !== 1) return blocked("INTENT_MISMATCH")

    const operation = transaction.operations[0]
    if (operation.type !== "payment" || operation.source !== undefined || !operation.asset.isNative() || operation.destination !== input.toAddress || !Number.isFinite(Number(operation.amount)) || Number(operation.amount) !== input.amount) return blocked("INTENT_MISMATCH")
    if (transaction.memo.type !== "text") return blocked("INTENT_MISMATCH")
    const memoValue = transaction.memo.value
    if (typeof memoValue !== "string" && !Buffer.isBuffer(memoValue)) return blocked("INTENT_MISMATCH")
    const memo = typeof memoValue === "string" ? memoValue : memoValue.toString("utf8")
    if (memo !== input.a2uPaymentId.substring(0, 28)) return blocked("INTENT_MISMATCH")

    const signature = transaction.signatures[0]
    const keypair = StellarSDK.Keypair.fromPublicKey(input.fromAddress)
    if (!signature.hint().equals(keypair.signatureHint()) || !keypair.verify(transaction.hash(), signature.signature())) return blocked("SIGNATURE_INVALID")
  } catch {
    return blocked("INTENT_MISMATCH")
  }

  return {
    outcome: "VERIFIED_INTENT",
    reference: {
      envelopeXdr: input.envelopeXdr,
      preparedHash: input.preparedHash,
      preparedSequence: input.preparedSequence,
      a2uPaymentId: input.a2uPaymentId,
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      amount: input.amount,
    },
    moneyMovementProven: false,
    authorizesFinancialAction: false,
  }
}
