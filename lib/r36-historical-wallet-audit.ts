/** R36 historical wallet audit. READ ONLY; a scoped negative finding is never a release certificate.
 * PostgreSQL evidence alone cannot prove completeness of Horizon outbound history.
 * A missing wallet link on refunds is an explicit unresolved blocker, not evidence of absence.
 */
export type R36HistoryAudit = Readonly<{
  outcome: 'BLOCKED'; reason: string; authorizesRotation: false;
  counts?: Readonly<{ settlements: number; ambiguousSettlements: number; unresolvedRefunds: number;
    authorityHistory: number; submissionAttempts: number; finalitySeals: number }>;
}>
type Row = Record<string, unknown>
type Reader = { query(sql: string, params: readonly unknown[]): Promise<{rows: Row[]}> }
const deny = (reason: string, counts?: R36HistoryAudit['counts']): R36HistoryAudit =>
  ({outcome:'BLOCKED',reason,authorizesRotation:false,...(counts?{counts}:{})})
const nonnegative = (v:unknown):number|null => typeof v==='number' && Number.isSafeInteger(v) && v>=0?v:null
/** All queries are SELECT only; no activation, approval, or financial write. */
export async function auditR36WalletHistoryReadOnly(db:Reader, network:string, wallet:string):Promise<R36HistoryAudit> {
  if(network!=='Pi Testnet'||!/^G[A-Z2-7]{55}$/.test(wallet)) return deny('INVALID_SCOPE')
  try {
    const [s,r,h,t,f] = await Promise.all([
      db.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed'))::int AS ambiguous
        FROM settlement_checkpoints WHERE a2u_from_address=$1`,[wallet]),
      // This is deliberately global: refund_checkpoints does not contain a proven wallet link.
      db.query(`SELECT count(*)::int AS total FROM refund_checkpoints
        WHERE status IN ('pending','manual_review_required')`,[]),
      db.query(`SELECT count(*)::int AS total FROM financial_wallet_authority_history
        WHERE network=$1 AND source_wallet=$2`,[network,wallet]),
      db.query(`SELECT count(*)::int AS total FROM financial_wallet_submission_attempts
        WHERE network=$1 AND source_wallet=$2`,[network,wallet]),
      db.query(`SELECT count(*)::int AS total FROM financial_wallet_finality_seals
        WHERE network=$1 AND source_wallet=$2`,[network,wallet])
    ])
    if([s,r,h,t,f].some(x=>!Array.isArray(x.rows)||x.rows.length!==1))return deny('INCOMPLETE_QUERY_RESULT')
    const nums=[s.rows[0].total,s.rows[0].ambiguous,r.rows[0].total,h.rows[0].total,t.rows[0].total,f.rows[0].total].map(nonnegative)
    if(nums.some(x=>x===null))return deny('INVALID_COUNTS')
    const [settlements,ambiguousSettlements,unresolvedRefunds,authorityHistory,submissionAttempts,finalitySeals]=nums as number[]
    const counts={settlements,ambiguousSettlements,unresolvedRefunds,authorityHistory,submissionAttempts,finalitySeals}
    if(ambiguousSettlements>0)return deny('AMBIGUOUS_SETTLEMENTS',counts)
    if(unresolvedRefunds>0)return deny('UNSCOPED_REFUNDS_OUTSTANDING',counts)
    if(finalitySeals>submissionAttempts)return deny('FINALITY_WITHOUT_ATTEMPT_COUNT_ANOMALY',counts)
    // Even with zero unresolved rows, there is no proven complete outbound Horizon inventory,
    // no refund-wallet join, and no serializable financial-writer exclusion protocol.
    return deny('HORIZON_HISTORY_COMPLETENESS_AND_REFUND_WALLET_BINDING_UNPROVEN',counts)
  } catch {return deny('HISTORY_READ_ERROR')}
}
