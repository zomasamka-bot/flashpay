import * as StellarSDK from "@stellar/stellar-sdk"
import { exactStroopAmountMatch, numberToExactPositiveStroops } from "./financial-amount-stroops"

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

type XdrDiagnosticCheck = Readonly<{ check: string; passed: boolean; expected?: unknown; observed?: unknown }>

function logXdrDiagnostic(reason: "INVALID_INPUT" | "XDR_INVALID" | "INTENT_MISMATCH" | "SIGNATURE_INVALID", checks: readonly XdrDiagnosticCheck[]): void {
  try {
    console.error("[SETTLEMENT_SUBMIT_XDR_DIAGNOSTIC]", {
      reason,
      failedChecks: checks.filter((check) => !check.passed).map((check) => check.check),
      checks,
      authorizesFinancialAction: false,
    })
  } catch {}
}

const blocked = (reason: "INVALID_INPUT" | "XDR_INVALID" | "INTENT_MISMATCH" | "SIGNATURE_INVALID", checks: readonly XdrDiagnosticCheck[] = []): SettlementSubmitXdrVerifierResult => {
  logXdrDiagnostic(reason, checks)
  return {
    outcome: "BLOCKED",
    reason,
    reference: null,
    moneyMovementProven: false,
    authorizesFinancialAction: false,
  }
}

export function verifySettlementSubmitXdrIntent(input: SettlementSubmitXdrVerifierInput): SettlementSubmitXdrVerifierResult {
  const inputChecks: XdrDiagnosticCheck[] = [
    { check: "envelopeXdrCanonical", passed: typeof input.envelopeXdr === "string" && !!input.envelopeXdr.trim() && input.envelopeXdr === input.envelopeXdr.trim() },
    { check: "preparedHashFormat", passed: /^[0-9a-f]{64}$/.test(input.preparedHash) },
    { check: "preparedSequenceFormat", passed: /^[1-9][0-9]*$/.test(input.preparedSequence) },
    { check: "a2uPaymentIdCanonical", passed: typeof input.a2uPaymentId === "string" && !!input.a2uPaymentId.trim() && input.a2uPaymentId === input.a2uPaymentId.trim() },
    { check: "fromAddressCanonical", passed: typeof input.fromAddress === "string" && !!input.fromAddress.trim() && input.fromAddress === input.fromAddress.trim() },
    { check: "toAddressCanonical", passed: typeof input.toAddress === "string" && !!input.toAddress.trim() && input.toAddress === input.toAddress.trim() },
    { check: "amountPositiveFinite", passed: typeof input.amount === "number" && Number.isFinite(input.amount) && input.amount > 0, expected: "positive finite number", observed: input.amount },
    { check: "amountExactStroops", passed: numberToExactPositiveStroops(input.amount) !== null, expected: "positive exact safe-integer stroop amount", observed: input.amount },
  ]
  if (inputChecks.some((check) => !check.passed)) return blocked("INVALID_INPUT", inputChecks)

  let transaction: StellarSDK.Transaction
  try {
    const parsed = StellarSDK.TransactionBuilder.fromXDR(input.envelopeXdr, "Pi Testnet")
    if (!(parsed instanceof StellarSDK.Transaction)) return blocked("XDR_INVALID", [{ check: "parsedTransaction", passed: false, expected: "StellarSDK.Transaction", observed: "non-transaction envelope" }])
    transaction = parsed
  } catch (error) {
    return blocked("XDR_INVALID", [{ check: "xdrParse", passed: false, expected: "valid Pi Testnet transaction XDR", observed: error instanceof Error ? error.message : "parse error" }])
  }

  try {
    const transactionChecks: XdrDiagnosticCheck[] = [
      { check: "xdrRoundTripMatch", passed: transaction.toXDR() === input.envelopeXdr },
      { check: "hashMatch", passed: Buffer.from(transaction.hash()).toString("hex") === input.preparedHash, expected: input.preparedHash, observed: Buffer.from(transaction.hash()).toString("hex") },
      { check: "sequenceMatch", passed: transaction.sequence === input.preparedSequence, expected: input.preparedSequence, observed: transaction.sequence },
      { check: "sourceMatch", passed: transaction.source === input.fromAddress, expected: input.fromAddress, observed: transaction.source },
      { check: "operationCountMatch", passed: transaction.operations.length === 1, expected: 1, observed: transaction.operations.length },
      { check: "signatureCountMatch", passed: transaction.signatures.length === 1, expected: 1, observed: transaction.signatures.length },
    ]
    if (transactionChecks.some((check) => !check.passed)) return blocked("INTENT_MISMATCH", transactionChecks)

    const operation = transaction.operations[0]
    const operationChecks: XdrDiagnosticCheck[] = [
      { check: "operationTypeMatch", passed: operation.type === "payment", expected: "payment", observed: operation.type },
      { check: "operationSourceImplicit", passed: operation.source === undefined, expected: "undefined", observed: operation.source ?? "undefined" },
      { check: "assetNative", passed: operation.type === "payment" && operation.asset.isNative(), expected: "native", observed: operation.type === "payment" ? (operation.asset.isNative() ? "native" : operation.asset.getCode()) : operation.type },
      { check: "destinationMatch", passed: operation.type === "payment" && operation.destination === input.toAddress, expected: input.toAddress, observed: operation.type === "payment" ? operation.destination : operation.type },
      { check: "amountCanonicalStroops", passed: operation.type === "payment" && exactStroopAmountMatch(operation.amount, input.amount), expected: numberToExactPositiveStroops(input.amount), observed: operation.type === "payment" ? operation.amount : operation.type },
    ]
    if (operationChecks.some((check) => !check.passed)) return blocked("INTENT_MISMATCH", operationChecks)

    if (transaction.memo.type !== "text") return blocked("INTENT_MISMATCH", [{ check: "memoTypeMatch", passed: false, expected: "text", observed: transaction.memo.type }])
    const memoValue: unknown = transaction.memo.value
    const expectedMemo = input.a2uPaymentId.substring(0, 28)
    const expectedMemoBytes = Buffer.from(expectedMemo, "utf8")
    let memoMatches = false
    let observedMemo: string
    if (typeof memoValue === "string") {
      memoMatches = memoValue === expectedMemo
      observedMemo = memoValue
    } else if (memoValue instanceof Uint8Array) {
      const memoBytes = Buffer.from(memoValue)
      memoMatches = memoBytes.equals(expectedMemoBytes)
      observedMemo = memoMatches ? expectedMemo : `byte-length:${memoBytes.length}`
    } else {
      return blocked("INTENT_MISMATCH", [{ check: "memoValueShape", passed: false, expected: "string or Uint8Array", observed: memoValue === null ? "null" : typeof memoValue }])
    }
    if (!memoMatches) return blocked("INTENT_MISMATCH", [{ check: "memoMatch", passed: false, expected: expectedMemo, observed: observedMemo }])

    const signature = transaction.signatures[0]
    const keypair = StellarSDK.Keypair.fromPublicKey(input.fromAddress)
    const hintMatch = Buffer.from(signature.hint.toBytes()).equals(Buffer.from(keypair.signatureHint()))
    const signatureValid = keypair.verify(transaction.hash(), signature.signature.toBytes())
    if (!hintMatch || !signatureValid) return blocked("SIGNATURE_INVALID", [
      { check: "signatureHintMatch", passed: hintMatch },
      { check: "signatureCryptographicallyValid", passed: signatureValid },
    ])
  } catch (error) {
    return blocked("INTENT_MISMATCH", [{ check: "verifierException", passed: false, expected: "no verifier exception", observed: error instanceof Error ? error.message : "unknown" }])
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
