import {query} from './db'

export const validReviewId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(id)
type Cursor={after:string;dbDone:boolean;legacy:string;legacyDone:boolean}
export function decodeReviewCursor(value:string|null):Cursor|null{
 if(!value)return {after:'',dbDone:false,legacy:'0',legacyDone:false}
 if(value.length>600)return null
 try{const c=JSON.parse(Buffer.from(value,'base64url').toString());return c&&Object.keys(c).sort().join(',')==='after,dbDone,legacy,legacyDone'&&(c.after===''||validReviewId(c.after))&&typeof c.dbDone==='boolean'&&typeof c.legacyDone==='boolean'&&typeof c.legacy==='string'&&/^\d{1,20}$/.test(c.legacy)?c:null}catch{return null}
}
export function encodeReviewCursor(c:Cursor){return c.dbDone&&c.legacyDone?null:Buffer.from(JSON.stringify(c)).toString('base64url')}
// Read-only discovery. Work leases are never claimed or acknowledged by a UI read.
// Include pre-payment/settlement, refund/manual-review, and finalization work even
// if the Redis index or projection is absent. Each source is bounded by keyset.
export const REVIEW_DISCOVERY_SQL=`WITH candidates AS (
 (SELECT payment_id FROM public.r36_recovery_work WHERE payment_id>$1 ORDER BY payment_id LIMIT $2)
 UNION
 (SELECT s.payment_id FROM public.settlement_checkpoints s
  WHERE s.payment_id>$1 AND s.stage<>'db_finalized'
   AND NOT EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.payment_id=s.payment_id AND r.status='completed' AND r.stage='audit_recorded')
  ORDER BY s.payment_id LIMIT $2)
 UNION
 (SELECT r.payment_id FROM public.refund_checkpoints r
  WHERE r.payment_id>$1 AND (r.status<>'completed' OR r.stage<>'audit_recorded' OR r.updated_at>NOW()-INTERVAL '24 hours')
  ORDER BY r.payment_id LIMIT $2)
 UNION
 (SELECT i.payment_id FROM public.payment_create_intents i
  WHERE i.payment_id>$1 AND NOT EXISTS(SELECT 1 FROM public.settlement_checkpoints s WHERE s.payment_id=i.payment_id)
  ORDER BY i.payment_id LIMIT $2)
) SELECT payment_id FROM candidates ORDER BY payment_id LIMIT $2`
export async function discoverDurableReviewIds(after:string,limit:number){
 const rows=await query(REVIEW_DISCOVERY_SQL,[after,limit+1]);if(!Array.isArray(rows))throw Error('REVIEW_DISCOVERY_UNAVAILABLE')
 const ids=rows.map(r=>(r as {payment_id:string}).payment_id)
 if(ids.some(id=>!validReviewId(id)||id<=after)||new Set(ids).size!==ids.length)throw Error('REVIEW_DISCOVERY_INVALID')
 return {ids:ids.slice(0,limit),done:ids.length<=limit}
}
export async function readDurableReview(paymentId:string){
 const rows=await query(`SELECT coalesce(s.payment_id,i.payment_id) AS payment_id,
  coalesce(s.merchant_id,i.merchant_id) AS merchant_id,coalesce(s.merchant_uid,i.merchant_uid) AS merchant_uid,
  coalesce(s.customer_amount,i.customer_amount)::text AS customer_amount,
  coalesce(s.created_at,i.created_at)::text AS created_at,s.stage,
  s.u2a_identifier,s.u2a_txid,s.u2a_completed_at::text,s.a2u_payment_id,s.a2u_txid,
  s.pi_completed_at::text,s.db_finalized_at::text,s.payer_uid
 FROM (SELECT * FROM public.settlement_checkpoints WHERE payment_id=$1) s
 FULL JOIN (SELECT * FROM public.payment_create_intents WHERE payment_id=$1) i USING(payment_id) LIMIT 2`,[paymentId])
 if(!Array.isArray(rows)||rows.length>1)throw Error('REVIEW_DURABLE_UNAVAILABLE')
 return rows[0] as Record<string,unknown>|undefined
}
