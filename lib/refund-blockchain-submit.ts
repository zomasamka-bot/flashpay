import "server-only"

import {
  Asset,
  Horizon,
  Memo,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  TimeoutInfinite,
} from "@stellar/stellar-sdk"
import type { RefundCheckpoint } from "./types"
import type { RefundPiPayment } from "./refund-pi-reconciliation"
import { authorizeRefundBlockchainSubmit, ensureRefundPreparedSubmit } from "./refund-checkpoint-store"

export type RefundBlockchainSubmitResult =
  | { outcome: "CONFIRMED_TX"; txid: string }
  | { outcome: "FAILED"; code: "invalid_input" | "configuration" | "source_load_failed" | "build_failed" | "submit_failed"; message: string }

type Input = {
  checkpoint: RefundCheckpoint
  payment: RefundPiPayment
}

const HORIZON_URL = "https://api.testnet.minepi.com"

type RefundPreparedSubmitXdrInput = {
  envelopeXdr: string
  preparedHash: string
  preparedSequence: string
  refundPaymentId: string
  fromAddress: string
  toAddress: string
  amount: number
}

export function verifyRefundPreparedSubmitXdr(input: RefundPreparedSubmitXdrInput): { outcome: "VERIFIED_INTENT" | "BLOCKED"; reference: RefundPreparedSubmitXdrInput | null; moneyMovementProven: false; authorizesFinancialAction: false } {
  const blocked = { outcome: "BLOCKED" as const, reference: null, moneyMovementProven: false as const, authorizesFinancialAction: false as const }
  if (!input.envelopeXdr || input.envelopeXdr !== input.envelopeXdr.trim() || !input.preparedHash || !/^[0-9a-f]{64}$/.test(input.preparedHash) || !input.preparedSequence || !/^[1-9][0-9]*$/.test(input.preparedSequence) || !input.refundPaymentId || input.refundPaymentId !== input.refundPaymentId.trim() || !input.fromAddress || input.fromAddress !== input.fromAddress.trim() || !input.toAddress || input.toAddress !== input.toAddress.trim() || !isValidPositiveAmount(input.amount)) return blocked
  try {
    const transaction = TransactionBuilder.fromXDR(input.envelopeXdr, "Pi Testnet")
    if (!(transaction instanceof Transaction) || transaction.toXDR() !== input.envelopeXdr || Buffer.from(transaction.hash()).toString("hex") !== input.preparedHash || transaction.sequence !== input.preparedSequence || transaction.source !== input.fromAddress || transaction.timeBounds?.minTime !== "0" || transaction.timeBounds?.maxTime !== "0" || transaction.signatures.length !== 1 || transaction.operations.length !== 1) return blocked
    const operation = transaction.operations[0]
    if (operation.type !== "payment" || operation.source || operation.asset.type !== "native" || operation.destination !== input.toAddress || operation.amount !== input.amount.toFixed(7)) return blocked
    const memo = transaction.memo
    if (memo.type !== "text" || typeof memo.value !== "string" || memo.value.trim() !== input.refundPaymentId) return blocked
    const keypair = Keypair.fromPublicKey(input.fromAddress)
    if (!keypair.verify(transaction.hash(), transaction.signatures[0].signature) || !transaction.signatures[0].hint.equals(keypair.signatureHint())) return blocked
    return { outcome: "VERIFIED_INTENT", reference: input, moneyMovementProven: false, authorizesFinancialAction: false }
  } catch {
    return blocked
  }
}

function isValidPositiveAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0 && Number.isSafeInteger(value * 10_000_000)
}

function isExactInput({ checkpoint, payment }: Input): boolean {
  return checkpoint.stage === "wallet_submission_started" && checkpoint.status === "pending" &&
    typeof checkpoint.refundPaymentId === "string" && checkpoint.refundPaymentId === payment.identifier &&
    checkpoint.paymentId === payment.metadata.paymentId && checkpoint.refundId === payment.metadata.refundId &&
    checkpoint.idempotencyKey === payment.metadata.idempotencyKey && checkpoint.payerUid === payment.user_uid &&
    isValidPositiveAmount(checkpoint.amount) && isValidPositiveAmount(payment.amount) && checkpoint.amount === payment.amount &&
    payment.direction === "app_to_user" && payment.network === "Pi Testnet" &&
    payment.metadata.type === "refund" && payment.transaction === null &&
    payment.status.cancelled === false && payment.status.user_cancelled === false &&
    typeof payment.from_address === "string" && payment.from_address.length > 0 &&
    typeof payment.to_address === "string" && payment.to_address.length > 0
}

export async function submitRefundBlockchainOnce(input: Input): Promise<RefundBlockchainSubmitResult> {
  if (!isExactInput(input)) return { outcome: "FAILED", code: "invalid_input", message: "Refund input is not an eligible unsent Testnet refund" }
  const seed = process.env.PI_PRIVATE_SEED
  if (!seed) return { outcome: "FAILED", code: "configuration", message: "Refund signing configuration is unavailable" }

  let keypair: Keypair
  try {
    keypair = Keypair.fromSecret(seed)
    if (keypair.publicKey() !== input.payment.from_address) return { outcome: "FAILED", code: "invalid_input", message: "Refund source does not match the configured signer" }
  } catch {
    return { outcome: "FAILED", code: "configuration", message: "Refund signing configuration is invalid" }
  }

  let server: Horizon.Server
  let source: Awaited<ReturnType<Horizon.Server["loadAccount"]>>
  let baseFee: Awaited<ReturnType<Horizon.Server["fetchBaseFee"]>>
  try {
    server = new Horizon.Server(HORIZON_URL)
    source = await server.loadAccount(input.payment.from_address)
    baseFee = await server.fetchBaseFee()
  } catch (error) {
    return { outcome: "FAILED", code: "source_load_failed", message: error instanceof Error ? error.message : "Refund source loading failed" }
  }

  let transaction: ReturnType<TransactionBuilder["build"]>
  try {
    transaction = new TransactionBuilder(source, {
      fee: baseFee.toString(),
      networkPassphrase: input.payment.network,
    })
      .addOperation(Operation.payment({ destination: input.payment.to_address, asset: Asset.native(), amount: input.payment.amount.toFixed(7) }))
      .addMemo(Memo.text(input.payment.identifier))
      .setTimeout(TimeoutInfinite)
      .build()
    transaction.sign(keypair)
  } catch (error) {
    return { outcome: "FAILED", code: "build_failed", message: error instanceof Error ? error.message : "Refund transaction build failed" }
  }

  const envelopeXdr = transaction.toXDR()
  const preparedHash = Buffer.from(transaction.hash()).toString("hex")
  const preparedSequence = transaction.sequence
  const prepared = await ensureRefundPreparedSubmit(input.checkpoint.refundId, input.checkpoint.paymentId, input.checkpoint.idempotencyKey, input.payment.identifier, envelopeXdr, preparedHash, preparedSequence)
  if (!prepared || prepared.preparedNow !== true || prepared.envelopeXdr !== envelopeXdr || prepared.preparedHash !== preparedHash || prepared.preparedSequence !== preparedSequence) return { outcome: "FAILED", code: "submit_failed", message: "Refund transaction was not confirmed" }

  const authorization = await authorizeRefundBlockchainSubmit(input.checkpoint.refundId, input.checkpoint.paymentId, input.checkpoint.idempotencyKey, input.payment.identifier, envelopeXdr, preparedHash, preparedSequence, "system")
  if (!authorization || authorization.authorizedNow !== true) return { outcome: "FAILED", code: "submit_failed", message: "Refund transaction was not confirmed" }

  try {
    const result = await server.submitTransaction(transaction)
    if (result.successful !== true || result.hash !== preparedHash) return { outcome: "FAILED", code: "submit_failed", message: "Refund transaction was not confirmed" }
    return { outcome: "CONFIRMED_TX", txid: result.hash }
  } catch (error) {
    return { outcome: "FAILED", code: "submit_failed", message: error instanceof Error ? error.message : "Refund transaction submission failed" }
  }
}
