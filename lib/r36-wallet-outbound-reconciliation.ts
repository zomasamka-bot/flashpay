/** R36 strict outbound matching engine. Pure, no I/O, no certificate or authorization.
 * Horizon pagination/completeness and PostgreSQL snapshot/locks MUST be established
 * by a separate trusted caller; this function never infers them from supplied arrays.
 */
export type R36Outbound = Readonly<{hash:string; sourceWallet:string; destination:string; amountStroops:string; kind:'settlement'|'refund'; paymentId:string}>
export type R36HorizonMovement = Readonly<{hash:string; sourceWallet:string; destination:string; amountStroops:string; successful:boolean}>
export type R36ReconcileResult = Readonly<{outcome:'BLOCKED';reason:string;authorizesRotation:false;matched:number}>
const hash=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x)
const wallet=(x:unknown)=>typeof x==='string'&&/^G[A-Z2-7]{55}$/.test(x)
const amount=(x:unknown)=>typeof x==='string'&&/^[1-9]\d*$/.test(x)&&BigInt(x)<=BigInt('9223372036854775807')
const deny=(reason:string,matched=0):R36ReconcileResult=>({outcome:'BLOCKED',reason,matched,authorizesRotation:false})
/** Input is untrusted; even a perfect match never grants historical completeness. */
export function reconcileR36OutboundCandidates(sourceWallet:string, durable:readonly R36Outbound[], horizon:readonly R36HorizonMovement[], unresolvedRefundCount:number):R36ReconcileResult {
  if(!wallet(sourceWallet)||!Array.isArray(durable)||!Array.isArray(horizon)||!Number.isSafeInteger(unresolvedRefundCount)||unresolvedRefundCount<0) return deny('INVALID_INPUT')
  if(unresolvedRefundCount!==0)return deny('UNRESOLVED_OR_UNSCOPED_REFUNDS')
  const durableByHash=new Map<string,R36Outbound>()
  for(const d of durable){
    if(!d||!hash(d.hash)||!wallet(d.sourceWallet)||!wallet(d.destination)||!amount(d.amountStroops)||!d.paymentId||!['settlement','refund'].includes(d.kind)||d.sourceWallet!==sourceWallet)return deny('INVALID_DURABLE_MOVEMENT')
    if(durableByHash.has(d.hash))return deny('DUPLICATE_DURABLE_HASH')
    durableByHash.set(d.hash,d)
  }
  const seen=new Set<string>()
  for(const h of horizon){
    if(!h||!hash(h.hash)||!wallet(h.sourceWallet)||!wallet(h.destination)||!amount(h.amountStroops)||h.sourceWallet!==sourceWallet||h.successful!==true)return deny('INVALID_HORIZON_MOVEMENT')
    if(seen.has(h.hash))return deny('DUPLICATE_HORIZON_HASH')
    seen.add(h.hash)
    const d=durableByHash.get(h.hash)
    if(!d)return deny('UNEXPLAINED_HORIZON_OUTBOUND')
    if(d.destination!==h.destination||d.amountStroops!==h.amountStroops)return deny('HORIZON_DURABLE_MISMATCH')
  }
  if(seen.size!==durableByHash.size)return deny('DURABLE_MOVEMENT_MISSING_ON_HORIZON')
  // A caller-supplied array cannot establish Horizon full-history pagination, source-account
  // coverage, legacy payment classification, or a stable shared financial-writer lock.
  return deny('MATCHED_CANDIDATES_BUT_COMPLETENESS_UNPROVEN',seen.size)
}
