/** R36 candidate historical coverage + durable accounting join. Pure, read-only, DENY ONLY.
 * Caller-supplied provenance is never accepted as completeness/finality authority.
 * A transaction hash can contain multiple operations: movement identity MUST include operation ID.
 */
export type HistoricalMovement=Readonly<{operationId:string;transactionHash:string;ledger:number;source:string;destination:string;amountStroops:string;successful:boolean}>
export type DurableMovement=Readonly<{operationId:string;transactionHash:string;source:string;destination:string;amountStroops:string;paymentId:string;kind:'settlement'|'refund';stage:string;accountingEntryId:string}>
export type HistoricalJoinResult=Readonly<{outcome:'BLOCKED';reason:string;authorizesRotation:false;matched:number}>
const deny=(reason:string,matched=0):HistoricalJoinResult=>({outcome:'BLOCKED',reason,matched,authorizesRotation:false})
const wallet=(x:unknown):x is string=>typeof x==='string'&&/^G[A-Z2-7]{55}$/.test(x)
const hash=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x)
const decimal=(x:unknown):x is string=>typeof x==='string'&&/^[1-9][0-9]*$/.test(x)&&BigInt(x)<=BigInt('9223372036854775807')
/** Preconditions are deliberately strict; not a substitute for Horizon genesis/tip verification,
 * ledger-close attestation, all-operation classification, PostgreSQL writer exclusion, or full accounting proof.
 */
export function auditR36HistoricalDurableJoin(input:{wallet:string;genesisLedger:number;upperLedger:number;horizon:readonly HistoricalMovement[];durable:readonly DurableMovement[];unresolvedRefunds:number;unresolvedSettlements:number}):HistoricalJoinResult{
 const {wallet:source,genesisLedger,upperLedger,horizon,durable,unresolvedRefunds,unresolvedSettlements}=input
 if(!wallet(source)||!Number.isSafeInteger(genesisLedger)||genesisLedger<1||!Number.isSafeInteger(upperLedger)||upperLedger<genesisLedger||!Array.isArray(horizon)||!Array.isArray(durable)||!Number.isSafeInteger(unresolvedRefunds)||unresolvedRefunds<0||!Number.isSafeInteger(unresolvedSettlements)||unresolvedSettlements<0)return deny('INVALID_SCOPE_OR_INPUT')
 if(unresolvedRefunds!==0||unresolvedSettlements!==0)return deny('UNRESOLVED_FINANCIAL_STATE')
 const byId=new Map<string,DurableMovement>(),paymentKinds=new Map<string,string>(),accountingIds=new Set<string>()
 for(const d of durable){
  if(!d||typeof d.operationId!=='string'||!/^[1-9][0-9]*$/.test(d.operationId)||!hash(d.transactionHash)||!wallet(d.source)||!wallet(d.destination)||d.source!==source||!decimal(d.amountStroops)||typeof d.paymentId!=='string'||!d.paymentId.trim()||!['settlement','refund'].includes(d.kind)||typeof d.accountingEntryId!=='string'||!d.accountingEntryId.trim())return deny('INVALID_DURABLE_EVIDENCE')
  if(d.kind==='settlement'&&d.stage!=='db_finalized'||d.kind==='refund'&&d.stage!=='completed')return deny('NON_FINAL_DURABLE_MOVEMENT')
  if(byId.has(d.operationId))return deny('DUPLICATE_DURABLE_OPERATION')
  if(accountingIds.has(d.accountingEntryId))return deny('DUPLICATE_ACCOUNTING_ENTRY')
  accountingIds.add(d.accountingEntryId)
  const old=paymentKinds.get(d.paymentId)
  if(old&&old!==d.kind)return deny('SETTLEMENT_REFUND_XOR_VIOLATION')
  paymentKinds.set(d.paymentId,d.kind);byId.set(d.operationId,d)
 }
 const seen=new Set<string>();let matched=0
 for(const h of horizon){
  if(!h||typeof h.operationId!=='string'||!/^[1-9][0-9]*$/.test(h.operationId)||!hash(h.transactionHash)||!Number.isSafeInteger(h.ledger)||h.ledger<genesisLedger||h.ledger>upperLedger||!wallet(h.source)||!wallet(h.destination)||h.source!==source||!decimal(h.amountStroops)||h.successful!==true)return deny('INVALID_HORIZON_EVIDENCE',matched)
  if(seen.has(h.operationId))return deny('DUPLICATE_HORIZON_OPERATION',matched)
  seen.add(h.operationId)
  const d=byId.get(h.operationId)
  if(!d)return deny('UNEXPLAINED_HORIZON_OPERATION',matched)
  if(d.transactionHash!==h.transactionHash||d.source!==h.source||d.destination!==h.destination||d.amountStroops!==h.amountStroops)return deny('HORIZON_DURABLE_MISMATCH',matched)
  matched++
 }
 if(seen.size!==byId.size)return deny('DURABLE_OPERATION_MISSING_ON_HORIZON',matched)
 return deny('CANDIDATE_JOIN_MATCHED_COMPLETENESS_AND_ATOMICITY_UNPROVEN',matched)
}
