/** R36 independent Horizon evidence check. READ-ONLY, never authorizes rotation.
 * The result is diagnostic evidence, NOT a durable approval. The caller must
 * independently verify PostgreSQL accounting and historical wallet inventory.
 */
import { Asset, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { verifyR36TransactionResultXdr } from './r36-transaction-result-evidence'

export type R36HorizonProofInput = Readonly<{
  network: 'Pi Testnet'; preparedHash: string; preparedSequence: string;
  sourceWallet: string; destinationWallet: string; amount: string;
  envelopeXdr: string; expectedFeeStroops: string;
}>
export type R36HorizonRecord = Readonly<{
  hash?: unknown; successful?: unknown; ledger?: unknown; fee_charged?: unknown;
  source_account?: unknown; source_account_sequence?: unknown;
  envelope_xdr?: unknown; result_xdr?: unknown;
}>
export type R36ProofResult = Readonly<{
  outcome: 'PROVEN' | 'BLOCKED'; reason: string;
  authorizesRotation: false; ledger?: string; feeStroops?: string;
}>
const blocked = (reason: string): R36ProofResult => ({ outcome: 'BLOCKED', reason, authorizesRotation: false })
const decimal = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(value)) return null
  const [whole, frac = ''] = value.split('.')
  const stroops = BigInt(whole) * BigInt('10000000') + BigInt(frac.padEnd(7, '0'))
  return stroops > BigInt(0) ? stroops.toString() : null
}
export function verifyR36IndependentHorizonRecord(input: R36HorizonProofInput, record: R36HorizonRecord): R36ProofResult {
  if (input.network !== 'Pi Testnet' || !/^[0-9a-f]{64}$/.test(input.preparedHash) ||
      !/^[1-9]\d*$/.test(input.preparedSequence) || !/^G[A-Z2-7]{55}$/.test(input.sourceWallet) ||
      !/^G[A-Z2-7]{55}$/.test(input.destinationWallet) || !/^(0|[1-9]\d*)$/.test(input.expectedFeeStroops) ||
      decimal(input.amount) === null || !input.envelopeXdr) return blocked('INVALID_INPUT')
  try {
    const parsed = TransactionBuilder.fromXDR(input.envelopeXdr, input.network)
    if (!(parsed instanceof Transaction) || parsed.toXDR() !== input.envelopeXdr ||
        Buffer.from(parsed.hash()).toString('hex') !== input.preparedHash ||
        parsed.source !== input.sourceWallet || parsed.sequence !== input.preparedSequence ||
        parsed.operations.length !== 1) return blocked('PREPARED_XDR_MISMATCH')
    const op = parsed.operations[0]
    if (op.type !== 'payment' || op.source !== undefined || !(op.asset instanceof Asset) || !op.asset.isNative() ||
        op.destination !== input.destinationWallet || decimal(op.amount) !== decimal(input.amount)) return blocked('PAYMENT_INTENT_MISMATCH')
    if (record.hash !== input.preparedHash || record.successful !== true ||
        record.source_account !== input.sourceWallet || String(record.source_account_sequence) !== input.preparedSequence ||
        !/^[1-9]\d*$/.test(String(record.ledger)) ||
        String(record.fee_charged) !== input.expectedFeeStroops ||
        typeof record.envelope_xdr !== 'string' || record.envelope_xdr !== input.envelopeXdr ||
        typeof record.result_xdr !== 'string' || !record.result_xdr) return blocked('HORIZON_RECORD_MISMATCH')
    const resultEvidence = verifyR36TransactionResultXdr(record.result_xdr, input.expectedFeeStroops)
    if (resultEvidence.outcome !== 'VALID_RESULT') return blocked(resultEvidence.reason)
    return { outcome: 'PROVEN', reason: 'EXACT_HORIZON_TRANSACTION_MATCH',
      authorizesRotation: false, ledger: String(record.ledger), feeStroops: String(record.fee_charged) }
  } catch { return blocked('XDR_OR_RECORD_INVALID') }
}
/** Fetches only a fixed Pi Testnet Horizon transaction endpoint; no POST or retry.
 * The injected fetch is used only for isolated testing. Never expose this as a public API.
 */
export async function readR36IndependentHorizonProof(
  input: R36HorizonProofInput,
  fetcher: typeof fetch = fetch,
): Promise<R36ProofResult> {
  if (!/^[0-9a-f]{64}$/.test(input.preparedHash)) return blocked('INVALID_HASH')
  try {
    const response = await fetcher(`https://api.testnet.minepi.com/transactions/${input.preparedHash}`, {
      method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return blocked('HORIZON_UNAVAILABLE_OR_NOT_FOUND')
    const record: unknown = await response.json()
    if (!record || typeof record !== 'object' || Array.isArray(record)) return blocked('INVALID_HORIZON_RESPONSE')
    return verifyR36IndependentHorizonRecord(input, record as R36HorizonRecord)
  } catch { return blocked('HORIZON_READ_FAILED') }
}
