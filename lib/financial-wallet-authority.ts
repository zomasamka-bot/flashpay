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
/** R36 production schema + ACL admission. No DDL, no financial writes.
 * Missing tables, missing privileges, or inaccessible catalog => DENY.
 * This is a necessary condition, never a clearance or wallet release.
 */
export async function checkR36SchemaAdmission(db: { unsafe: (sql: string, values: unknown[]) => Promise<unknown[]> }): Promise<boolean> {
  try {
    const rows = await db.unsafe(`
      WITH required(name) AS (VALUES
        ('financial_wallet_authorities'),('financial_wallet_activation'),
        ('financial_wallet_authority_history'),('financial_wallet_submission_attempts'),
        ('financial_wallet_finality_seals'),('financial_wallet_rotation_approvals'),
        ('r36_rotation_approval_evidence'),('r36_signed_approval_consumptions')),
      catalog AS (
        SELECT name, to_regclass('public.' || name) AS oid FROM required
      )
      SELECT count(*) FILTER (WHERE oid IS NOT NULL) AS present,
        count(*) FILTER (WHERE oid IS NOT NULL AND
          (SELECT c.relkind FROM pg_class c WHERE c.oid=catalog.oid) IN ('r','p')) AS real_tables,
        coalesce(bool_or(CASE WHEN name IN
          ('financial_wallet_rotation_approvals','r36_rotation_approval_evidence',
           'financial_wallet_activation',
           'financial_wallet_authority_history','r36_signed_approval_consumptions')
          THEN oid IS NULL OR
            has_table_privilege(current_user,oid,'INSERT') OR
            has_table_privilege(current_user,oid,'UPDATE') OR
            has_table_privilege(current_user,oid,'DELETE') OR
            pg_has_role(current_user,(SELECT c.relowner FROM pg_class c WHERE c.oid=catalog.oid),'MEMBER')
          ELSE false END),true) AS can_mutate_protected,
        coalesce(bool_or(CASE WHEN oid IS NOT NULL AND
          name='financial_wallet_submission_attempts'
          THEN NOT has_table_privilege(current_user,oid,'INSERT')
          ELSE false END),true) AS missing_attempt_insert
      FROM catalog
    `, [])
    const r = Array.isArray(rows) ? rows[0] as {
      present: string|number; real_tables: string|number;
      can_mutate_protected: boolean; missing_attempt_insert: boolean
    } : null
    if (!r || Number(r.present) !== 8 || Number(r.real_tables) !== 8 ||
        r.can_mutate_protected !== false || r.missing_attempt_insert !== false) return false
    // The app must never execute the operator-only wallet-owner rotation
    // function, including via PUBLIC or an inherited role. Reject privileged
    // DB identities that can bypass ordinary table ACL checks.
    const acl = await db.unsafe(`
      SELECT NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user)
          AS unprivileged,
        CASE WHEN to_regprocedure('public.r36_rotate_wallet_owner_quarantined(text,text,text,text,text,text,text,text,text)') IS NULL
          THEN true ELSE NOT has_function_privilege(current_user,
            'public.r36_rotate_wallet_owner_quarantined(text,text,text,text,text,text,text,text,text)', 'EXECUTE')
        END AS cannot_rotate
    `, [])
    const a = Array.isArray(acl) ? acl[0] as { unprivileged: boolean; cannot_rotate: boolean } : null
    if (!a || a.unprivileged !== true || a.cannot_rotate !== true) return false
    // An app role with ownership, CREATEROLE, schema CREATE or attestation DML
    // can manufacture its own trust boundary despite an apparent function gate.
    // All checks are against CURRENT_USER in the same DB transaction.
    const boundary = await db.unsafe(`
      SELECT
        NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole) AS restricted_role,
        NOT has_schema_privilege(current_user,'public','CREATE') AS cannot_create_public,
        to_regclass('public.r36_independent_u2a_attestations') IS NOT NULL AS attestation_present,
        CASE WHEN to_regclass('public.r36_independent_u2a_attestations') IS NULL THEN false
          ELSE NOT (has_table_privilege(current_user,'public.r36_independent_u2a_attestations','INSERT')
             OR has_table_privilege(current_user,'public.r36_independent_u2a_attestations','UPDATE')
             OR has_table_privilege(current_user,'public.r36_independent_u2a_attestations','DELETE')
             OR pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='public.r36_independent_u2a_attestations'::regclass),'MEMBER')) END AS cannot_forge_attestation,
        CASE WHEN to_regprocedure('public.r36_claim_prepared_authority(text,text,text,text,text,text,text)') IS NULL THEN false
          ELSE has_function_privilege(current_user,'public.r36_claim_prepared_authority(text,text,text,text,text,text,text)','EXECUTE') END AS claim_executable
      FROM pg_roles r WHERE r.rolname=current_user
    `, [])
    const b = Array.isArray(boundary) ? boundary[0] as {
      restricted_role:boolean; cannot_create_public:boolean; attestation_present:boolean;
      cannot_forge_attestation:boolean; claim_executable:boolean
    } : null
    return !!b && b.restricted_role === true && b.cannot_create_public === true &&
      b.attestation_present === true && b.cannot_forge_attestation === true && b.claim_executable === true
  } catch { return false }
}

export async function claimPreparedWalletAuthority(input: WalletAuthorityClaim, tx?: { unsafe: (sql: string, values: unknown[]) => Promise<unknown[]> }): Promise<boolean> {
  if (input.network !== 'Pi Testnet' ||
      !/^G[A-Z2-7]{55}$/.test(input.sourceWallet) ||
      !input.paymentId || input.paymentId.trim() !== input.paymentId ||
      !input.operationId || input.operationId.trim() !== input.operationId ||
      !['settlement', 'refund'].includes(input.operationKind) ||
      !/^[0-9a-f]{64}$/.test(input.preparedHash) ||
      !/^[1-9][0-9]*$/.test(input.preparedSequence)) return false
  // Fail closed before attempting any durable wallet authority mutation.
  // The optional transaction is mandatory for atomic prepare and uses the same DB client.
  if (!tx || !(await checkR36SchemaAdmission(tx))) return false
  // Unique (network,source_wallet) serializes contenders. Conflict is
  // intentionally NOT reassigned, even after Redis loss, TTL or restart.
  // Exact same owner+prepared identity is the only allowed replay.
  // R36-A candidate: DB SECURITY DEFINER function enforces immutable issuer attestation.
  // This intentionally fails closed if the protected function is not installed.
  // The runtime DB role must have EXECUTE only; no direct authority/attestation DML.
  try {
    const rows = await tx.unsafe(`
      SELECT public.r36_claim_prepared_authority($1,$2,$3,$4,$5,$6,$7) AS admitted`,
      [input.network,input.sourceWallet,input.paymentId,input.operationKind,
       input.operationId,input.preparedHash,input.preparedSequence])
    return Array.isArray(rows) && rows.length === 1 && rows[0]?.admitted === true
  } catch {
    return false
  }
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
    if (!(await checkR36SchemaAdmission({ unsafe: async (sql, values) => {
      const rows = await query(sql, values)
      if (!rows) throw new Error('R36_SCHEMA_QUERY_NULL')
      return rows
    } }))) return false
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
        -- Unknown or same-wallet pending refunds remain blockers. Only exact
        -- immutable R36 authority for a DIFFERENT wallet can exclude one.
        AND NOT EXISTS (SELECT 1 FROM refund_checkpoints r
          WHERE r.payment_id<>$3 AND r.status IN ('pending','manual_review_required')
            AND NOT EXISTS (
              SELECT 1 FROM financial_wallet_authorities ra
              WHERE ra.network=$1 AND ra.operation_kind='refund'
                AND ra.owner_payment_id=r.payment_id
                AND ra.owner_operation_id=r.refund_id
                AND ra.source_wallet<>$2
                AND ra.state='prepared'
            ))
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
