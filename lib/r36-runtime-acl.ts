/** Read-only boundary for the installed R36 schema, including succession and
 * reservation accounting. Runtime may use the original constrained functions;
 * direct table/column mutations or private-helper execution must deny admission.
 * Execute on the physical transaction that will perform the runtime operation.
 */
export async function checkR36RuntimeAcl(db: {
  unsafe(query: string, values: unknown[]): Promise<unknown[]>
}): Promise<boolean> {
  try {
    const rows = await db.unsafe(`
      WITH required(name) AS (VALUES
        ('financial_wallet_authorities'),('financial_wallet_activation'),
        ('financial_wallet_authority_history'),('financial_wallet_submission_attempts'),
        ('financial_wallet_finality_seals'),('financial_wallet_rotation_approvals'),
        ('r36_rotation_approval_evidence'),('r36_signed_approval_consumptions'),
        ('r36_independent_u2a_attestations'),('r36_certificate_policies'),
        ('r36_certificate_requests'),('r36_certificate_receipts'),('r36_certificate_revocations'),
        ('r36_recovery_trial_reservations'),('r36_testnet_ingress_reservations'),
        ('r36_wallet_successor_requests')),
      objects AS (SELECT to_regclass('public.' || name) AS oid FROM required),
      helpers(signature) AS (VALUES
        ('public.r36_claim_bound_successor(text,text,text,text,text,text,text)'),
        ('public.r36_terminal_ingress_clearance(text,text,text)')),
      functions AS (SELECT to_regprocedure(signature) AS oid FROM helpers)
      SELECT count(*)=16 AND bool_and(c.oid IS NOT NULL AND c.relkind IN ('r','p'))
        AND NOT coalesce(bool_or(CASE WHEN c.oid IS NULL THEN true ELSE
          has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')
          OR pg_has_role(current_user,c.relowner,'MEMBER') END),true) AS tables_safe,
        (SELECT count(*)=2 AND bool_and(oid IS NOT NULL)
          AND NOT coalesce(bool_or(CASE WHEN oid IS NULL THEN true
            ELSE has_function_privilege(current_user,oid,'EXECUTE') END),true)
          FROM functions) AS helpers_private
      FROM objects o LEFT JOIN pg_class c ON c.oid=o.oid
    `, [])
    const row = rows.length === 1 ? rows[0] as {tables_safe?:unknown;helpers_private?:unknown} : null
    return row?.tables_safe === true && row.helpers_private === true
  } catch { return false }
}
