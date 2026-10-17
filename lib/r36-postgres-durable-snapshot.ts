/** R36: actual-schema PostgreSQL snapshot preflight. Read-only; always BLOCKED.
 * No operation ID or refund source-wallet is present in these base checkpoint tables.
 * This adapter MUST NOT manufacture a HistoricalDurableJoin DurableMovement.
 */
export type SnapshotOutcome = Readonly<{outcome:'BLOCKED';authorizesRotation:false;reason:string;settlements?:number;refunds?:number;unresolved?:number}>
export type SqlRows = {rows: Record<string,unknown>[]}
export type PgSnapshotClient = {query(sql:string, params?:readonly unknown[]):Promise<SqlRows>;release():void}
export type PgSnapshotPool = {connect():Promise<PgSnapshotClient>}
const blocked=(reason:string, extra:Partial<Pick<SnapshotOutcome,'settlements'|'refunds'|'unresolved'>>={}):SnapshotOutcome=>({outcome:'BLOCKED',authorizesRotation:false,reason,...extra})
const count=(x:unknown):number|null=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0?x:null
const wallet=(x:unknown):x is string=>typeof x==='string'&&/^G[A-Z2-7]{55}$/.test(x)
/** Caller supplies an already configured Pool. This function never reads env or contacts a network itself.
 * The PostgreSQL role MUST have SELECT-only permissions. No SET TRANSACTION outside the explicit BEGIN.
 */
export async function inspectR36DurableSnapshot(pool:PgSnapshotPool, sourceWallet:string):Promise<SnapshotOutcome>{
 if(!wallet(sourceWallet))return blocked('INVALID_WALLET')
 let client:PgSnapshotClient|undefined;let started=false
 try{
  client=await pool.connect()
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  started=true
  // A single connection, one MVCC snapshot. No Promise.all across pooled sessions.
  const s=await client.query(`SELECT count(*)::int AS total,
   count(*) FILTER (WHERE stage <> 'db_finalized')::int AS unresolved,
   count(*) FILTER (WHERE stage = 'db_finalized' AND (a2u_txid IS NULL OR prepared_tx_hash IS DISTINCT FROM a2u_txid))::int AS invalid
   FROM settlement_checkpoints WHERE a2u_from_address=$1`,[sourceWallet])
  // Refund checkpoints lack an authoritative source-wallet column. Read globally, deny any unresolved,
  // and NEVER infer that completed refunds belong to this wallet.
  const r=await client.query(`SELECT count(*)::int AS total,
   count(*) FILTER (WHERE status <> 'completed')::int AS unresolved,
   count(*) FILTER (WHERE status = 'completed' AND refund_txid IS NULL)::int AS invalid
   FROM refund_checkpoints`)
  // Check for same-payment XOR across both tables, even if settlement scope is unknown.
  const x=await client.query(`SELECT count(*)::int AS total FROM settlement_checkpoints s
   INNER JOIN refund_checkpoints r ON r.payment_id=s.payment_id
   WHERE s.a2u_from_address=$1 AND (s.stage <> 'payment_identity' OR r.status='completed')`,[sourceWallet])
  if([s,r,x].some(z=>!Array.isArray(z.rows)||z.rows.length!==1))return blocked('INCOMPLETE_QUERY_RESULT')
  const values=[s.rows[0].total,s.rows[0].unresolved,s.rows[0].invalid,r.rows[0].total,r.rows[0].unresolved,r.rows[0].invalid,x.rows[0].total].map(count)
  if(values.some(v=>v===null))return blocked('INVALID_COUNTS')
  const [settlements,su,si,refunds,ru,ri,xor]=values as number[]
  if(su||si||ru||ri||xor)return blocked('DURABLE_ANOMALY_OR_UNRESOLVED',{settlements,refunds,unresolved:su+ru})
  return blocked('REFUND_WALLET_BINDING_OPERATION_IDS_ACCOUNTING_AND_HORIZON_COMPLETENESS_UNPROVEN',{settlements,refunds,unresolved:0})
 }catch{return blocked('POSTGRES_SNAPSHOT_READ_FAILED')}
 finally{
  if(client){if(started){try{await client.query('ROLLBACK')}catch{/* fail closed */}}try{client.release()}catch{/* fail closed */}}
 }
}
