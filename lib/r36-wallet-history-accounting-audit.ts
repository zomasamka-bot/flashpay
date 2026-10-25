/** Stage42 phase1: read-only wallet-history/accounting discrepancy detector.
 * NEVER issues certification, rotates a wallet, or treats a caller's arrays as authenticated.
 * All input records are untrusted observations. Horizon provenance, creation boundary,
 * finalized upper ledger, database snapshot isolation and finality remain independent gates.
 */
import {createHash} from 'node:crypto'
export type Outbound = Readonly<{hash:string;sequence:string;destination:string;amountStroops:string;kind:'settlement'|'refund';paymentId:string}>
export type Evidence = Readonly<{network:string;wallet:string;horizon:readonly Outbound[];durable:readonly Outbound[];pendingCount:number;ambiguousCount:number;unclassifiedCount:number}>
export type Audit = Readonly<{outcome:'BLOCKED';reason:string;authorizesRotation:false;matched:number;horizonCount:number;durableCount:number;diagnosticDigest?:string}>
const deny=(reason:string,h=0,d=0,m=0,digest?:string):Audit=>({outcome:'BLOCKED',reason,authorizesRotation:false,matched:m,horizonCount:h,durableCount:d,...(digest?{diagnosticDigest:digest}:{})})
const hash=(v:string)=>/^[0-9a-f]{64}$/.test(v)
const wallet=(v:string)=>/^G[A-Z2-7]{55}$/.test(v)
const positive=(v:string)=>/^[1-9][0-9]*$/.test(v)
function valid(r:Outbound):boolean{return !!r&&hash(r.hash)&&positive(r.sequence)&&wallet(r.destination)&&positive(r.amountStroops)&&['settlement','refund'].includes(r.kind)&&typeof r.paymentId==='string'&&r.paymentId.length>0}
const key=(r:Outbound)=>r.hash
const identity=(r:Outbound)=>JSON.stringify([r.hash,r.sequence,r.destination,r.amountStroops,r.kind,r.paymentId])
export function compareR36WalletHistoryAccounting(input:Evidence):Audit {
 try {
  if(!input||input.network!=='Pi Testnet'||!wallet(input.wallet)||!Array.isArray(input.horizon)||!Array.isArray(input.durable))return deny('INVALID_SCOPE')
  const h=input.horizon.length,d=input.durable.length
  if(!Number.isSafeInteger(input.pendingCount)||input.pendingCount<0||!Number.isSafeInteger(input.ambiguousCount)||input.ambiguousCount<0||!Number.isSafeInteger(input.unclassifiedCount)||input.unclassifiedCount<0)return deny('INVALID_COUNTS',h,d)
  if(input.pendingCount||input.ambiguousCount||input.unclassifiedCount)return deny('UNRESOLVED_OR_UNCLASSIFIED_OPERATIONS',h,d)
  const hm=new Map<string,string>(),dm=new Map<string,string>()
  for(const [rows,map] of [[input.horizon,hm],[input.durable,dm]] as const){for(const r of rows){if(!valid(r))return deny('INVALID_RECORD',h,d);if(map.has(key(r)))return deny('DUPLICATE_HASH',h,d);map.set(key(r),identity(r))}}
  if(h!==d)return deny('HISTORY_COUNT_MISMATCH',h,d)
  let matched=0
  for(const [k,v] of hm){if(!dm.has(k))return deny('HORIZON_OUTBOUND_MISSING_DURABLE',h,d,matched);if(dm.get(k)!==v)return deny('OUTBOUND_IDENTITY_MISMATCH',h,d,matched);matched++}
  for(const k of dm.keys())if(!hm.has(k))return deny('DURABLE_OUTBOUND_MISSING_HORIZON',h,d,matched)
  const diagnosticDigest=createHash('sha256').update(JSON.stringify([...hm].sort(([a],[b])=>a.localeCompare(b)))).digest('hex')
  return deny('RECORDS_MATCH_BUT_PROVENANCE_COMPLETENESS_AND_ACCOUNTING_FINALITY_UNCERTIFIED',h,d,matched,diagnosticDigest)
 }catch{return deny('AUDIT_ERROR')}
}
