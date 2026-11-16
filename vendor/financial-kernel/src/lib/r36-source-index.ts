/** Fixed, read-only projections of active source rows. The index is maintained
 * in the SAME transaction as the original rows; it never grants a permission. */
import {R36_SOURCE_QUERIES,type R36LiveSnapshot,type R36SourceRow as Row} from './r36-live-source'
const keys:Record<string,string[]>={intents:['payment_id'],settlements:['payment_id'],refunds:['refund_id'],transactions:['id'],receipts:['id'],refundAccounting:['refund_id'],refundAudit:['event_id'],merchantBalances:['merchant_id'],authorities:['network','source_wallet'],authorityHistory:['network','source_wallet','prepared_tx_hash'],executionScopes:['scope_digest'],legacyHolds:['payment_id']}
function fields(query:string){const text=query.slice(7,query.indexOf(' FROM public.'));let start=0,depth=0,quote=false;const out:string[]=[];for(let i=0;i<=text.length;i++){if(text[i]==="'")quote=!quote;if(!quote){if(text[i]==='(')depth++;if(text[i]===')')depth--}if(i===text.length||text[i]===','&&!quote&&depth===0){const part=text.slice(start,i).trim();out.push(/ AS ([a-z_]+)$/i.exec(part)?.[1]??part.replace(/::text$/,''));start=i+1}}if(out.some(f=>!/^[a-z_][a-z0-9_]*$/.test(f)))throw Error('SOURCE_INDEX_FIELDS');return out}
export async function readR36IndexedRows(tx:{unsafe(sql:string):Promise<Row[]>}):Promise<R36LiveSnapshot['rows']>{
 const data={} as R36LiveSnapshot['rows'];let bytes=0
 for(const name of Object.keys(R36_SOURCE_QUERIES) as (keyof typeof R36_SOURCE_QUERIES)[]){
  const rows=await tx.unsafe(`SELECT projection FROM r36_evidence_source.work WHERE kind='${name}' ORDER BY ${keys[name].map(k=>`(projection->>'${k}')${['transactions','receipts'].includes(name)?'::uuid':''}`).join(',')} LIMIT 20001`)
  if(rows.length>20000)throw Error('SOURCE_ROWS_BOUNDED')
  const columns=fields(R36_SOURCE_QUERIES[name]);data[name]=rows.map(r=>{const p=r.projection as Row;if(!p||typeof p!=='object'||Array.isArray(p))throw Error('SOURCE_INDEX_ROW');return Object.fromEntries(columns.filter(k=>!(name==='settlements'&&k==='financial_contract'&&!Object.hasOwn(p,k))).map(k=>{if(!Object.hasOwn(p,k))throw Error('SOURCE_INDEX_FIELD_MISSING');return[k,p[k]]}))})
  bytes+=Buffer.byteLength(JSON.stringify(data[name]));if(bytes>96000000)throw Error('SOURCE_BYTES_BOUNDED')
 }
 return data
}

import {checkpointFromDatabase,type R36CheckpointContext} from './r36-certified-history'
export async function readR36IndexedCheckpoint(tx:{unsafe(sql:string):Promise<Row[]>},paymentId?:string):Promise<R36CheckpointContext|undefined>{
 const exists=await tx.unsafe("SELECT to_regclass('public.r36_history_checkpoint_heads') IS NOT NULL AS installed")
 if(exists[0]?.installed!==true)return undefined
 const heads=await tx.unsafe(`SELECT h.policy_digest,h.source_wallet,c.digest,c.checkpoint_text,c.revoked,p.enabled,p.revoked policy_revoked,e.version,e.revoked enrollment_revoked,a.epoch::text checkpoint_epoch
 FROM public.r36_history_checkpoint_heads h JOIN public.r36_history_checkpoints c ON c.digest=h.digest JOIN public.r36_history_activated a ON a.digest=c.digest JOIN public.r36_certificate_policies p ON p.policy_digest=h.policy_digest JOIN public.r36_history_enrollments e ON e.policy_digest=h.policy_digest AND e.source_wallet=h.source_wallet LIMIT 2`)
 if(heads.length===0)return undefined
 const head=heads[0]
 if(heads.length!==1||head.revoked!==false||head.enrollment_revoked!==false||head.policy_revoked!==false||head.enabled!==true||head.version!=='R36_CERTIFIED_HISTORY_CHECKPOINT_V1'||!/^G[A-Z2-7]{55}$/.test(String(head.source_wallet))||!/^[0-9a-f]{64}$/.test(String(head.policy_digest)))throw Error('CHECKPOINT_SOURCE_NOT_CURRENT')
 const policy=String(head.policy_digest),wallet=String(head.source_wallet)
 if(!/^[1-9][0-9]{0,18}$/.test(String(head.checkpoint_epoch)))throw Error('CHECKPOINT_EPOCH')
 const mappings=await tx.unsafe(`SELECT t.merchant_uid AS "merchantUid",t.merchant_id AS "merchantId",t.credit_stroops::text AS "creditStroops",t.opening_stroops::text AS "openingStroops"
 FROM (SELECT DISTINCT projection->>'merchant_id' id FROM r36_evidence_source.work WHERE kind IN ('merchantBalances','settlements')) m
 JOIN LATERAL (SELECT * FROM public.r36_history_credit_totals t WHERE t.policy_digest='${policy}' AND t.source_wallet='${wallet}' AND t.merchant_id=m.id ORDER BY epoch DESC LIMIT 1) t ON true LIMIT 20001`)
 if(mappings.length>20000)throw Error('CHECKPOINT_MERCHANT_BOUND')
 const openingBalances=await tx.unsafe(`SELECT b.merchant_id AS "merchantId",b.opening_stroops::text settled,b.opening_unsettled_stroops::text unsettled FROM public.r36_history_opening_balances b JOIN r36_evidence_source.work w ON w.kind='merchantBalances' AND w.projection->>'merchant_id'=b.merchant_id WHERE b.policy_digest='${policy}' AND b.source_wallet='${wallet}' LIMIT 20001`)
 if(openingBalances.length>20000)throw Error('CHECKPOINT_OPENING_BOUND')
 let inbound:unknown
 if(paymentId!==undefined){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(paymentId))throw Error('CHECKPOINT_PAYMENT_ID')
  const witness=await tx.unsafe(`SELECT n.record_text FROM public.settlement_checkpoints s JOIN public.r36_history_network_records n ON n.tx_hash=s.u2a_txid AND n.source_wallet='${wallet}' AND n.direction='incoming' JOIN public.r36_history_checkpoints c ON c.digest=n.checkpoint_digest AND NOT c.revoked AND c.policy_digest='${policy}' JOIN public.r36_history_activated a ON a.digest=c.digest AND a.policy_digest='${policy}' AND a.source_wallet='${wallet}' AND a.epoch<=${String(head.checkpoint_epoch)} WHERE s.payment_id='${paymentId}' LIMIT 2`)
  if(witness.length>1)throw Error('CHECKPOINT_INBOUND_CARDINALITY');if(witness.length)inbound=JSON.parse(String(witness[0].record_text))
 }
 return checkpointFromDatabase({digest:head.digest,checkpointText:head.checkpoint_text,credits:mappings,openingBalances,...(inbound?{inbound}:{})},policy,wallet)
}
