/** R36 diagnostic, read-only cross-check. NEVER inserts approval or rotates ownership.
 * A successful check is necessary evidence, NOT sufficient authorization: global
 * historical inventory, independent ledger result decoding and authorization remain open.
 */
import { createHash } from 'node:crypto'
import { readR36IndependentHorizonProof, type R36HorizonProofInput } from './r36-independent-horizon-proof'

type Queryable = { query: (sql: string, params: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }
export type R36GateResult = Readonly<{ outcome: 'MATCHED_NOT_AUTHORIZED' | 'BLOCKED'; reason: string; authorizesRotation: false; evidenceDigest?: string }>
const deny = (reason: string): R36GateResult => ({ outcome: 'BLOCKED', reason, authorizesRotation: false })
const fields = ['network', 'source_wallet', 'prepared_tx_hash', 'prepared_sequence'] as const
/** Caller supplies a dedicated READ-ONLY PostgreSQL client; never call with live financial write transaction. */
export async function checkR36HorizonAgainstDurableRecords(
  db: Queryable, input: R36HorizonProofInput, fetcher: typeof fetch,
): Promise<R36GateResult> {
  try {
    if (input.network !== 'Pi Testnet' || !/^[0-9a-f]{64}$/.test(input.preparedHash)) return deny('INVALID_INPUT')
    // Fixed SQL, parameterized, one wallet; no mutation. Fail closed on missing tables.
    const result = await db.query(`
      SELECT a.network,a.source_wallet,a.owner_payment_id,a.operation_kind,a.owner_operation_id,
             a.prepared_tx_hash,a.prepared_sequence,a.state,
             t.owner_payment_id AS attempt_payment,t.operation_kind AS attempt_kind,
             t.owner_operation_id AS attempt_operation,t.prepared_sequence AS attempt_sequence,
             f.owner_payment_id AS seal_payment,f.operation_kind AS seal_kind,
             f.owner_operation_id AS seal_operation,f.prepared_sequence AS seal_sequence,
             f.horizon_ledger,f.horizon_fee_stroops,f.evidence_digest
        FROM financial_wallet_authorities a
        JOIN financial_wallet_submission_attempts t
          ON t.network=a.network AND t.source_wallet=a.source_wallet
         AND t.prepared_tx_hash=a.prepared_tx_hash
        JOIN financial_wallet_finality_seals f
          ON f.network=a.network AND f.source_wallet=a.source_wallet
         AND f.prepared_tx_hash=a.prepared_tx_hash
       WHERE a.network=$1 AND a.source_wallet=$2 AND a.prepared_tx_hash=$3`,
      [input.network, input.sourceWallet, input.preparedHash],
    )
    if (result.rows.length !== 1) return deny('DURABLE_OWNER_ATTEMPT_OR_SEAL_MISSING')
    const r = result.rows[0]
    for (const [column, expected] of Object.entries({network:input.network,source_wallet:input.sourceWallet,
      prepared_tx_hash:input.preparedHash,prepared_sequence:input.preparedSequence,state:'prepared'})) {
      if (r[column] !== expected) return deny('DURABLE_AUTHORITY_MISMATCH')
    }
    for (const prefix of ['attempt', 'seal']) {
      if (r[`${prefix}_payment`] !== r.owner_payment_id || r[`${prefix}_kind`] !== r.operation_kind ||
          r[`${prefix}_operation`] !== r.owner_operation_id || r[`${prefix}_sequence`] !== input.preparedSequence)
        return deny('DURABLE_IDENTITY_MISMATCH')
    }
    if (!['settlement','refund'].includes(String(r.operation_kind)) ||
        typeof r.evidence_digest !== 'string' || !/^[0-9a-f]{64}$/.test(r.evidence_digest))
      return deny('INVALID_DURABLE_SEAL')
    // Only after durable identity check, perform one read-only Horizon GET.
    const proof = await readR36IndependentHorizonProof(input, fetcher)
    if (proof.outcome !== 'PROVEN') return deny(`HORIZON_${proof.reason}`)
    if (proof.ledger !== String(r.horizon_ledger) || proof.feeStroops !== String(r.horizon_fee_stroops))
      return deny('HORIZON_DURABLE_FINALITY_MISMATCH')
    // Deterministic digest for *this comparison*, not the preexisting seal's digest.
    // Do not conflate them: the seal may use a different evidence serialization.
    const evidenceDigest = createHash('sha256').update(JSON.stringify({
      network:input.network,hash:input.preparedHash,sequence:input.preparedSequence,
      source:input.sourceWallet,destination:input.destinationWallet,amount:input.amount,
      envelopeXdr:input.envelopeXdr,ledger:proof.ledger,fee:proof.feeStroops,
      ownerPayment:r.owner_payment_id,operationKind:r.operation_kind,ownerOperation:r.owner_operation_id,
    })).digest('hex')
    return { outcome:'MATCHED_NOT_AUTHORIZED',reason:'DURABLE_IDENTITY_AND_HORIZON_MATCH',authorizesRotation:false,evidenceDigest }
  } catch { return deny('DB_OR_HORIZON_READ_FAILED') }
}
