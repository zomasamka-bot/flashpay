import "server-only"

import {
  Asset,
  Horizon,
  Memo,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk"
import type { RefundCheckpoint } from "./types"
import type { RefundPiPayment } from "./refund-pi-reconciliation"

export type RefundBlockchainSubmitResult =
  | { outcome: "CONFIRMED_TX"; txid: string }
  | { outcome: "FAILED"; code: "invalid_input" | "configuration" | "source_load_failed" | "build_failed" | "submit_failed"; message: string }

type Input = {
  checkpoint: RefundCheckpoint
  payment: RefundPiPayment
}

const HORIZON_URL = "https://api.testnet.minepi.com"

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

  try {
    const server = new Horizon.Server(HORIZON_URL)
    const source = await server.loadAccount(input.payment.from_address)
    const baseFee = await server.fetchBaseFee()
    const timebounds = await server.fetchTimebounds(180)
    const transaction = new TransactionBuilder(source, {
      fee: baseFee.toString(),
      networkPassphrase: input.payment.network === "Pi Testnet" ? Networks.TESTNET : input.payment.network,
    })
      .addOperation(Operation.payment({ destination: input.payment.to_address, asset: Asset.native(), amount: input.payment.amount.toFixed(7) }))
      .addMemo(Memo.text(input.payment.identifier))
      .setTimebounds(timebounds.minTime, timebounds.maxTime)
      .build()
    transaction.sign(keypair)
    const result = await server.submitTransaction(transaction)
    if (!result.successful || typeof result.hash !== "string" || result.hash.length === 0) return { outcome: "FAILED", code: "submit_failed", message: "Refund transaction was not confirmed" }
    return { outcome: "CONFIRMED_TX", txid: result.hash }
  } catch (error) {
    return { outcome: "FAILED", code: "submit_failed", message: error instanceof Error ? error.message : "Refund transaction submission failed" }
  }
}

export const REFUND_TESTNET_PASSPHRASE = Networks.TESTNET
