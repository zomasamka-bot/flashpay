import {financialNetwork} from './financial-network'
import {verifyDatabaseBinding} from '../deployment'
import {deployment} from '../deployment'
import {readR36VersionedRows} from './r36-source-row-reuse'
/** Private read-only source adapter. No business functions, Redis, signing or DML.
 * The connection adapter must start REPEATABLE READ READ ONLY on one physical
 * connection. Diagnostic owner reads can collect facts, never establish custody.
 */
export type R36SourceRow=Record<string,unknown>
export type R36ReadOnlySource={beginReadOnly<T>(read:(tx:{unsafe(sql:string):Promise<R36SourceRow[]>})=>Promise<T>):Promise<T>}
export const R36_SOURCE_QUERIES={
 intents:`SELECT payment_id,merchant_uid,merchant_id,customer_amount::text,note,created_at FROM public.payment_create_intents ORDER BY payment_id LIMIT 20001`,
 settlements:`SELECT ${deployment().schema==='KERNEL_DEPLOYMENT_V2'?'financial_contract,':''}payment_id,stage,merchant_id,merchant_uid,payer_uid,customer_amount::text,merchant_amount::text,app_commission::text,u2a_identifier,u2a_txid,u2a_verified_at,u2a_completed_at,a2u_payment_id,a2u_from_address,a2u_to_address,prepared_envelope_xdr,prepared_tx_hash,prepared_sequence::text,a2u_txid,horizon_fee_stroops::text,horizon_confirmed_at,pi_completed_at,db_finalized_at FROM public.settlement_checkpoints ORDER BY payment_id LIMIT 20001`,
 refunds:`SELECT refund_id,payment_id,idempotency_key,status,stage,payer_uid,payer_uid_verified_at,amount::text,currency,source_payment_status,source_settlement_state,refund_payment_id,refund_txid FROM public.refund_checkpoints ORDER BY refund_id LIMIT 20001`,
 transactions:`SELECT id::text,payment_id,merchant_id,merchant_uid,amount::text,currency,status,reference FROM public.transactions ORDER BY id LIMIT 20001`,
 receipts:`SELECT id::text,transaction_id::text,merchant_id,merchant_uid,amount::text,currency,txid,u2a_identifier,u2a_txid,a2u_identifier,a2u_txid,customer_amount::text,merchant_amount::text,app_commission::text,horizon_fee_charged::text,app_net_impact::text,settlement_status FROM public.receipts ORDER BY id LIMIT 20001`,
 refundAccounting:`SELECT refund_id,payment_id,refund_payment_id,refund_txid,payer_uid,amount::text,horizon_fee_stroops::text,currency FROM public.refund_accounting_records ORDER BY refund_id LIMIT 20001`,
 refundAudit:`SELECT event_id,refund_id,payment_id,event_type,actor_type,idempotency_key,details FROM public.refund_audit_events WHERE event_type IN ('refund_blockchain_submit_prepared','refund_blockchain_submit_authorized','refund_projection_finalized') ORDER BY event_id LIMIT 20001`,
 merchantBalances:`SELECT merchant_id,settled::text,unsettled::text FROM public.merchant_balances ORDER BY merchant_id LIMIT 20001`,
 authorities:`SELECT network,source_wallet,owner_payment_id,operation_kind,owner_operation_id,prepared_tx_hash,prepared_sequence,state FROM public.financial_wallet_authorities ORDER BY network,source_wallet LIMIT 20001`,
 authorityHistory:`SELECT network,source_wallet,owner_payment_id,operation_kind,owner_operation_id,prepared_tx_hash,prepared_sequence,finality_evidence_digest FROM public.financial_wallet_authority_history ORDER BY network,source_wallet,prepared_tx_hash LIMIT 20001`,
 executionScopes:`SELECT scope_digest,policy_digest,source_wallet,scope_text FROM public.r36_wallet_execution_scopes ORDER BY scope_digest LIMIT 101`,
 legacyHolds:`SELECT payment_id,network,kind,state,authorizes_new_rights,original_snapshot_sha256,to_char(held_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS held_at FROM public.r36_legacy_right_holds ORDER BY payment_id LIMIT 20001`,
} as const
export type R36LiveSnapshot={session:R36SourceRow;rows:{-readonly [K in keyof typeof R36_SOURCE_QUERIES]:R36SourceRow[]};custody:'UNSIGNED_DIAGNOSTIC'|'READONLY_SERVICE_NOT_CERTIFIED'}
async function checkedRead<T>(db:R36ReadOnlySource,mode:'diagnostic'|'service',read:(tx:{unsafe(sql:string):Promise<R36SourceRow[]>},session:R36SourceRow)=>Promise<T>):Promise<T>{
 if(mode!=='diagnostic'&&mode!=='service')throw Error('SOURCE_MODE')
 return db.beginReadOnly(async tx=>{
  const rows=await tx.unsafe(`SELECT current_database() database,current_user::text role,session_user::text session_role,current_setting('neon.branch_id',true) branch,current_setting('transaction_read_only') read_only,current_setting('transaction_isolation') isolation,pg_current_snapshot()::text snapshot,clock_timestamp() captured_at`)
  const s=rows.length===1?rows[0]:null
  if(!s||s.database!==deployment().databaseName||s.branch!==deployment().databaseBranch||s.role!==s.session_role||s.read_only!=='on'||s.isolation!=='repeatable read')throw Error('SOURCE_SNAPSHOT_IDENTITY')
  if(mode==='service'){
   if(s.role!=='r36_evidence_reader')throw Error('SOURCE_READONLY_ROLE')
   const privileges=await tx.unsafe(`SELECT NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
    AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','r36_signing','r36_registration','r36_evidence_source') AND has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','r36_signing','r36_registration','r36_evidence_source') AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')))
    AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname IN ('public','r36_signing','r36_registration') AND has_function_privilege(r.oid,f.oid,'EXECUTE')) restricted
    FROM pg_roles r WHERE r.rolname=current_user`)
   if(privileges.length!==1||privileges[0].restricted!==true)throw Error('SOURCE_READONLY_ACL')
  }
  await verifyDatabaseBinding({unsafe:async(q)=>tx.unsafe(q)})
  return read(tx,s)
 })
}
/** Startup validates identity/ACL without transferring financial history. */
export async function verifyR36ReadOnlySource(db:R36ReadOnlySource){
 return checkedRead(db,'service',async(_tx,session)=>({session,custody:'READONLY_SERVICE_NOT_CERTIFIED' as const}))
}
/** Scheduling hint only. No evidence, authority or financial transition is
 * derived from this small read; a new proof still requires the full snapshot. */
export async function readR36LifecycleHead(db:R36ReadOnlySource,wallet:string){
 if(!/^G[A-Z2-7]{55}$/.test(wallet))throw Error('SOURCE_WALLET_IDENTITY')
 return checkedRead(db,'service',async tx=>{
  // The strict alphabet above excludes SQL delimiters. No caller SQL is accepted.
  const rows=await tx.unsafe(`SELECT a.network,a.source_wallet,a.owner_payment_id,a.operation_kind,a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence,a.state,
   CASE WHEN a.operation_kind='settlement' THEN EXISTS(SELECT 1 FROM public.settlement_checkpoints s WHERE s.payment_id=a.owner_payment_id AND s.stage='db_finalized')
   WHEN a.operation_kind='refund' THEN EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.payment_id=a.owner_payment_id AND r.refund_id=a.owner_operation_id AND r.status='completed' AND r.stage='audit_recorded')
   ELSE false END AS terminal_checkpoint
   FROM public.financial_wallet_authorities a WHERE a.network='${financialNetwork()}' AND a.source_wallet='${wallet}' LIMIT 2`)
  if(rows.length>1)throw Error('AUTOMATIC_AUTHORITY_CARDINALITY')
  if(!rows.length)return {authority:undefined,completed:false}
  const {terminal_checkpoint,...authority}=rows[0]
  if(typeof terminal_checkpoint!=='boolean'||authority.network!==financialNetwork()||authority.source_wallet!==wallet)throw Error('SOURCE_LIFECYCLE_HEAD')
  return {authority,completed:terminal_checkpoint}
 })
}
export async function readR36LiveSource(db:R36ReadOnlySource,mode:'diagnostic'|'service'):Promise<R36LiveSnapshot>{
 return checkedRead(db,mode,async(tx,s)=>{
  const data={} as R36LiveSnapshot['rows'];let size=0
  const names=Object.keys(R36_SOURCE_QUERIES) as (keyof typeof R36_SOURCE_QUERIES)[]
  // Include catalog identity and server lifetime: a rewrite, type/default change
  // or server restart cannot make an old tuple version stand for different data.
  const schemas=await tx.unsafe(`SELECT pg_postmaster_start_time()::text AS started,
   md5(coalesce(string_agg(row_to_json(d)::text,',' ORDER BY d.oid,d.attnum),'')) AS schema
   FROM (SELECT c.oid,c.relfilenode,CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid) ELSE NULL END AS viewdef,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attisdropped,a.atthasmissing,a.attmissingval,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=a.atttypid) AS labels
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname IN ('public','r36_evidence_source') AND c.relname IN ('payment_create_intents','settlement_checkpoints','refund_checkpoints','transactions','receipts','refund_accounting_records','refund_audit_events','merchant_balances','financial_wallet_authorities','financial_wallet_authority_history','r36_wallet_execution_scopes','r36_legacy_right_holds')) d`)
  if(schemas.length!==1||typeof schemas[0].started!=='string'||typeof schemas[0].schema!=='string')throw Error('SOURCE_VERSION_CATALOG')
  const versionSession={...s,version_scope:JSON.stringify([s.database,s.branch,schemas[0]])}
  // Pipeline fixed independent SELECTs on the SAME checked physical snapshot.
  // No pool expansion, SQL change, row coercion or identity/ACL bypass.
  for(let offset=0;offset<names.length;offset+=4){
   const group=names.slice(offset,offset+4)
   const results=await Promise.allSettled(group.map(name=>readR36VersionedRows(db,tx,R36_SOURCE_QUERIES[name],versionSession)))
   for(let index=0;index<group.length;index++){
   const result=results[index];if(result.status==='rejected')throw result.reason
   const name=group[index],value=result.value
   if(!Array.isArray(value)||value.length>20000||value.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw Error('SOURCE_ROWS_BOUNDED')
   size+=Buffer.byteLength(JSON.stringify(value));if(size>96_000_000)throw Error('SOURCE_BYTES_BOUNDED')
   data[name]=name==='settlements'?value.map(row=>{if(row.financial_contract===null){const {financial_contract,...legacy}=row;return legacy}return row}):value
   }
  }
  return {session:s,rows:data,custody:mode==='service'?'READONLY_SERVICE_NOT_CERTIFIED':'UNSIGNED_DIAGNOSTIC'}
 })
}
