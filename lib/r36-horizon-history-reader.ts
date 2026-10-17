/** R36 read-only, bounded Horizon account-operations collector.
 * This is a candidate inventory, NEVER a certificate of complete history.
 * No DB writes, no external mutations, no authority grants.
 */
import {inspectR36HorizonOperationPages, type R36Page, type R36Operation} from './r36-horizon-operation-inventory'
export type R36ReadResult=Readonly<{outcome:'BLOCKED';reason:string;authorizesRotation:false;pages:number;records:number;outbound:number;upperLedger:number|null;pageEvidence:readonly R36Page[]}>
const deny=(reason:string,pages:readonly R36Page[]=[],upperLedger:number|null=null,outbound=0):R36ReadResult=>({outcome:'BLOCKED',reason,authorizesRotation:false,pages:pages.length,records:pages.reduce((n,p)=>n+p.records.length,0),outbound,upperLedger,pageEvidence:pages})
const address=(v:string)=>/^G[A-Z2-7]{55}$/.test(v)
const cursor=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v)
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const permitted='https://api.testnet.minepi.com'
/** Explicit read-only fetch injection allows fully offline fault-injection tests.
 * No supplied URLs are fetched: only fixed-origin paths constructed here.
 * upperLedger must come from a separate finalized-ledger proof (not supplied by this function).
 */
export async function readR36HorizonHistoryCandidate(input:{walletId:string;upperLedger:number;maxPages?:number;timeoutMs?:number;fetcher?:typeof fetch}):Promise<R36ReadResult>{
 const {walletId,upperLedger}=input
 const maxPages=input.maxPages??1000,timeoutMs=input.timeoutMs??8000
 if(!address(walletId)||!Number.isSafeInteger(upperLedger)||upperLedger<1||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>10000||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)return deny('INVALID_INPUT')
 const fetcher=input.fetcher??fetch
 const pages:R36Page[]=[],seen=new Set<string>()
 let last:string|null=null,prior:bigint|null=null,outbound=0
 for(let index=0;index<maxPages;index++){
  const u=new URL(`/accounts/${walletId}/operations`,permitted)
  u.searchParams.set('order','asc');u.searchParams.set('limit','200');if(last)u.searchParams.set('cursor',last)
  let payload:unknown
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeoutMs)
  try{
   const response=await fetcher(u.toString(),{method:'GET',signal:abort.signal,redirect:'error',headers:{accept:'application/json'}})
   if(!response.ok)return deny(`HTTP_${response.status}`,pages,upperLedger,outbound)
   payload=await response.json()
  }catch{return deny('FETCH_OR_PARSE_FAILED',pages,upperLedger,outbound)}finally{clearTimeout(timer)}
  if(!payload||typeof payload!=='object')return deny('INVALID_PAGE_BODY',pages,upperLedger,outbound)
  const records=(payload as {_embedded?:{records?:unknown}})._embedded?.records
  if(!Array.isArray(records)||records.length>200)return deny('INVALID_PAGE_RECORDS',pages,upperLedger,outbound)
  if(records.length===0){
   // Empty tail is not proof of genesis coverage, finality, or complete account effects.
   if(pages.length===0)return deny('EMPTY_HISTORY_UNPROVEN',pages,upperLedger,outbound)
   const check=inspectR36HorizonOperationPages(walletId,pages)
   return deny(check.reason==='PAGE_CANDIDATES_ONLY_COMPLETENESS_UNPROVEN'?'TAIL_REACHED_COMPLETENESS_UNPROVEN':check.reason,pages,upperLedger,outbound)
  }
  const accepted:R36Operation[]=[]
  for(const raw of records){
   if(!raw||typeof raw!=='object')return deny('INVALID_OPERATION',pages,upperLedger,outbound)
   const row=raw as R36Operation&{ledger?:unknown}
   if(!cursor(row.paging_token)||row.id!==row.paging_token||!hash(row.transaction_hash)||typeof row.type!=='string'||!Number.isSafeInteger(row.ledger)||Number(row.ledger)<1)return deny('INVALID_OPERATION',pages,upperLedger,outbound)
   const n=BigInt(row.paging_token)
   if((prior!==null&&n<=prior)||seen.has(row.paging_token))return deny('NON_MONOTONIC_OR_DUPLICATE',pages,upperLedger,outbound)
   if(Number(row.ledger)>upperLedger){
    if(accepted.length)pages.push({requestedCursor:last,records:accepted,nextCursor:String(accepted[accepted.length-1].paging_token)})
    return deny('UPPER_LEDGER_BOUNDARY_REACHED_NOT_CERTIFIED',pages,upperLedger,outbound)
   }
   seen.add(row.paging_token);prior=n;accepted.push(row)
   if(row.type==='payment'&&row.from===walletId)outbound++
   else if(row.from===walletId&&row.type!=='payment')return deny('UNCLASSIFIED_SOURCE_OPERATION',pages,upperLedger,outbound)
  }
  const next=String(accepted[accepted.length-1].paging_token)
  pages.push({requestedCursor:last,records:accepted,nextCursor:next});last=next
  const check=inspectR36HorizonOperationPages(walletId,pages)
  if(check.reason!=='PAGE_CANDIDATES_ONLY_COMPLETENESS_UNPROVEN')return deny(check.reason,pages,upperLedger,outbound)
  if(records.length<200)return deny('SHORT_PAGE_NOT_COMPLETENESS_PROOF',pages,upperLedger,outbound)
 }
 return deny('PAGE_BUDGET_EXHAUSTED',pages,upperLedger,outbound)
}
