/** R36-GAP-01I: durable, fail-closed cross-payment wallet authority.
 * CANDIDATE ONLY: no automatic release; migration/backfill required before enabling.
 * This guard must be called for ALL financial submit writers before production use.
 */
import { query } from './db'
// An optional transaction client ensures the wallet claim and financial checkpoint
// are committed or rolled back together; never fall back to an independent query.
export type WalletAuthorityClaim = {
  network: string; sourceWallet: string; paymentId: string;
  operationKind: 'settlement' | 'refund'; operationId: string;
  preparedHash: string; preparedSequence: string;
}
export async function claimPreparedWalletAuthority(input: WalletAuthorityClaim, tx?: { unsafe: (sql: string, values: unknown[]) => Promise<unknown[]> }): Promise<boolean> {
  if (input.network !== 'Pi Testnet' ||
      !/^G[A-Z2-7]{55}$/.test(input.sourceWallet) ||
      !input.paymentId || input.paymentId.trim() !== input.paymentId ||
      !input.operationId || input.operationId.trim() !== input.operationId ||
      !['settlement', 'refund'].includes(input.operationKind) ||
      !/^[0-9a-f]{64}$/.test(input.preparedHash) ||
      !/^[1-9][0-9]*$/.test(input.preparedSequence)) return false
  // Unique (network,source_wallet) serializes contenders. Conflict is
  // intentionally NOT reassigned, even after Redis loss, TTL or restart.
  // Exact same owner+prepared identity is the only allowed replay.
  const rows = await (tx ? tx.unsafe.bind(tx) : query)(`
    INSERT INTO financial_wallet_authorities
      (network, source_wallet, owner_payment_id, operation_kind,
       owner_operation_id, prepared_tx_hash, prepared_sequence, state)
    SELECT $1,$2,$3,$4,$5,$6,$7,'prepared'
    WHERE EXISTS (SELECT 1 FROM financial_wallet_activation g
      WHERE g.network=$1 AND g.source_wallet=$2 AND g.state='enabled'
      AND g.clearance_digest ~ '^[0-9a-f]{64}$')
    AND NOT EXISTS (SELECT 1 FROM settlement_checkpoints s
      WHERE s.a2u_from_address=$2 AND s.payment_id<>$3
        AND s.stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed'))
    -- Refund checkpoints lack a trustworthy source-wallet column. Conservatively
    -- treat every OTHER pending/manual-review refund as a possible contender.
    AND NOT EXISTS (SELECT 1 FROM refund_checkpoints r
      WHERE r.payment_id<>$3 AND r.status IN ('pending','manual_review_required'))
    ON CONFLICT (network, source_wallet) DO UPDATE SET
      updated_at = financial_wallet_authorities.updated_at
    WHERE financial_wallet_authorities.owner_payment_id = EXCLUDED.owner_payment_id
      AND financial_wallet_authorities.operation_kind = EXCLUDED.operation_kind
      AND financial_wallet_authorities.owner_operation_id = EXCLUDED.owner_operation_id
      AND financial_wallet_authorities.prepared_tx_hash = EXCLUDED.prepared_tx_hash
      AND financial_wallet_authorities.prepared_sequence = EXCLUDED.prepared_sequence
      AND financial_wallet_authorities.state = 'prepared'
    RETURNING owner_payment_id, owner_operation_id, prepared_tx_hash, prepared_sequence`,
    [input.network,input.sourceWallet,input.paymentId,input.operationKind,
     input.operationId,input.preparedHash,input.preparedSequence])
  return Array.isArray(rows) && rows.length === 1 &&
    (rows[0] as {owner_payment_id: string})?.owner_payment_id === input.paymentId &&
    (rows[0] as {owner_operation_id: string})?.owner_operation_id === input.operationId &&
    (rows[0] as {prepared_tx_hash: string})?.prepared_tx_hash === input.preparedHash &&
    String((rows[0] as {prepared_sequence: string})?.prepared_sequence) === input.preparedSequence
}

/** R36 fail-closed exact durable prepared-identity gate at Horizon boundary.
 * Read-only. Does not grant/reassign authority, or authorize retry.
 */
export async function verifyPreparedWalletAuthority(input: WalletAuthorityClaim): Promise<boolean> {
  if (input.network !== 'Pi Testnet' || !/^G[A-Z2-7]{55}$/.test(input.sourceWallet) ||
      !input.paymentId || !input.operationId || !['settlement','refund'].includes(input.operationKind) ||
      !/^[0-9a-f]{64}$/.test(input.preparedHash) || !/^[1-9][0-9]*$/.test(input.preparedSequence)) return false
  try {
    const rows = await query(`SELECT 1 AS owned FROM financial_wallet_authorities
      WHERE network=$1 AND source_wallet=$2 AND owner_payment_id=$3
        AND operation_kind=$4 AND owner_operation_id=$5
        AND prepared_tx_hash=$6 AND prepared_sequence=$7 AND state='prepared'
      LIMIT 1`, [input.network,input.sourceWallet,input.paymentId,input.operationKind,
      input.operationId,input.preparedHash,input.preparedSequence])
    return Array.isArray(rows) && rows.length === 1 && (rows[0] as {owned: number})?.owned === 1
  } catch { return false }
}


/** R36: One durable attempt per immutable envelope across every executor.
 * This is deliberately fail-closed: a committed attempt BEFORE HTTP may mean
 * no movement took place. Recovery MUST reconcile GET-only and NEVER resend.
 * No INSERT is possible until an operator has independently cleared the
 * wallet's historical outstanding movements and explicitly enabled its gate.
 */
export async function claimFirstWalletSubmission(input: WalletAuthorityClaim): Promise<boolean> {
  if (input.network !== 'Pi Testnet' || !/^G[A-Z2-7]{55}$/.test(input.sourceWallet) ||
      !input.paymentId || input.paymentId.trim() !== input.paymentId ||
      !input.operationId || input.operationId.trim() !== input.operationId ||
      !['settlement', 'refund'].includes(input.operationKind) ||
      !/^[0-9a-f]{64}$/.test(input.preparedHash) ||
      !/^[1-9][0-9]*$/.test(input.preparedSequence)) return false
  try {
    // A single INSERT statement makes the exact-owner check and append-only
    // one-shot admission atomic. The authority row is locked until commit;
    // lock conflicts and database outages always deny the submit.
    const rows = await query(`
      INSERT INTO financial_wallet_submission_attempts
        (network,source_wallet,owner_payment_id,operation_kind,owner_operation_id,prepared_tx_hash,prepared_sequence)
      SELECT a.network,a.source_wallet,a.owner_payment_id,a.operation_kind,
             a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence
      FROM financial_wallet_authorities a
      JOIN financial_wallet_activation g
        ON g.network=a.network AND g.source_wallet=a.source_wallet
       AND g.state='enabled' AND g.clearance_digest ~ '^[0-9a-f]{64}$'
      WHERE a.network=$1 AND a.source_wallet=$2 AND a.owner_payment_id=$3
        AND a.operation_kind=$4 AND a.owner_operation_id=$5
        AND a.prepared_tx_hash=$6 AND a.prepared_sequence=$7 AND a.state='prepared'
        AND NOT EXISTS (SELECT 1 FROM settlement_checkpoints s
          WHERE s.a2u_from_address=$2 AND s.payment_id<>$3
            AND s.stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed'))
        AND NOT EXISTS (SELECT 1 FROM refund_checkpoints r
          WHERE r.payment_id<>$3 AND r.status IN ('pending','manual_review_required'))
      FOR UPDATE OF a
      ON CONFLICT DO NOTHING
      RETURNING prepared_tx_hash`,
      [input.network,input.sourceWallet,input.paymentId,input.operationKind,
       input.operationId,input.preparedHash,input.preparedSequence])
    return Array.isArray(rows) && rows.length === 1 && (rows[0] as {prepared_tx_hash: string})?.prepared_tx_hash === input.preparedHash
  } catch { return false }
}


/** R36 finality-seal protocol, phase 1: immutable evidence recording ONLY.
 * This never releases/reassigns a wallet. Horizon GET success and exact XDR
 * must be verified independently before calling. A later release transition
 * requires a separate certified protocol; no automated release is permitted.
 * Any database error or mismatched identity denies the seal.
 */
export async function recordWalletFinalitySeal(input: WalletAuthorityClaim & {
  horizonLedger: string; horizonFeeStroops: string;
  evidenceDigest: string; verifiedBy: string;
}): Promise<boolean> {
  if (input.network !== 'Pi Testnet' || !/^G[A-Z2-7]{55}$/.test(input.sourceWallet) ||
      !input.paymentId || !input.operationId ||
      !['settlement', 'refund'].includes(input.operationKind) ||
      !/^[0-9a-f]{64}$/.test(input.preparedHash) ||
      !/^[1-9][0-9]*$/.test(input.preparedSequence) ||
      !/^[1-9][0-9]*$/.test(input.horizonLedger) ||
      !/^(0|[1-9][0-9]*)$/.test(input.horizonFeeStroops) ||
      !/^[0-9a-f]{64}$/.test(input.evidenceDigest) ||
      !input.verifiedBy?.trim()) return false
  try {
    const rows = await query(`
      INSERT INTO financial_wallet_finality_seals
        (network,source_wallet,owner_payment_id,operation_kind,owner_operation_id,
         prepared_tx_hash,prepared_sequence,horizon_ledger,horizon_fee_stroops,
         evidence_digest,verified_by)
      SELECT a.network,a.source_wallet,a.owner_payment_id,a.operation_kind,
             a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence,
             $8,$9,$10,$11
      FROM financial_wallet_authorities a
      JOIN financial_wallet_submission_attempts t
        ON t.network=a.network AND t.source_wallet=a.source_wallet
       AND t.owner_payment_id=a.owner_payment_id
       AND t.operation_kind=a.operation_kind
       AND t.owner_operation_id=a.owner_operation_id
       AND t.prepared_tx_hash=a.prepared_tx_hash
       AND t.prepared_sequence=a.prepared_sequence
      WHERE a.network=$1 AND a.source_wallet=$2 AND a.owner_payment_id=$3
        AND a.operation_kind=$4 AND a.owner_operation_id=$5
        AND a.prepared_tx_hash=$6 AND a.prepared_sequence=$7
        AND a.state='prepared'
        AND (
          (a.operation_kind='settlement' AND EXISTS (
            SELECT 1 FROM settlement_checkpoints s
            WHERE s.payment_id=a.owner_payment_id AND s.stage='db_finalized'
              AND s.a2u_from_address=a.source_wallet
              AND s.prepared_tx_hash=a.prepared_tx_hash
              AND s.a2u_txid=a.prepared_tx_hash
              AND s.prepared_sequence::text=a.prepared_sequence
              AND s.horizon_confirmed_at IS NOT NULL AND s.db_finalized_at IS NOT NULL
              AND s.horizon_fee_stroops=$9::bigint))
          OR
          (a.operation_kind='refund' AND EXISTS (
            SELECT 1 FROM refund_checkpoints r
            WHERE r.refund_id=a.owner_operation_id AND r.payment_id=a.owner_payment_id
              AND r.status='completed' AND r.stage='audit_recorded'
              AND r.refund_txid=a.prepared_tx_hash))
        )
      FOR UPDATE OF a
      ON CONFLICT DO NOTHING
      RETURNING prepared_tx_hash`,
      [input.network,input.sourceWallet,input.paymentId,input.operationKind,
       input.operationId,input.preparedHash,input.preparedSequence,
       input.horizonLedger,input.horizonFeeStroops,input.evidenceDigest,input.verifiedBy])
    return Array.isArray(rows) && rows.length === 1 && (rows[0] as {prepared_tx_hash: string})?.prepared_tx_hash === input.preparedHash
  } catch { return false }
}
