import "server-only"
import { isRecord } from "@/lib/pi-reconciliation"

function exact(v: unknown): string | null { return typeof v === "string" && v.trim() !== "" && v === v.trim() ? v : null }
export type HorizonAbsenceProof = { outcome:"ABSENT" } | { outcome:"MOVEMENT_PRESENT"|"INDETERMINATE"; reason:string }

export async function proveA2UStage1HorizonAbsence(pi: Record<string,unknown>, a2uPaymentId:string):Promise<HorizonAbsenceProof>{
  const source=exact(pi.from_address), createdRaw=exact(pi.created_at), created=createdRaw?Date.parse(createdRaw):NaN
  if(!source||!/^G[A-Z2-7]{55}$/.test(source)||!Number.isFinite(created))return{outcome:"INDETERMINATE",reason:"PI_SOURCE_OR_TIME_INVALID"}
  const stopBefore=created-300000; let url=`https://api.testnet.minepi.com/accounts/${encodeURIComponent(source)}/transactions?order=desc&limit=200&include_failed=true`
  for(let page=0;page<20;page++){
    let response:Response; try{response=await fetch(url,{cache:"no-store"})}catch{return{outcome:"INDETERMINATE",reason:"HORIZON_READ_FAILED"}}
    if(!response.ok)return{outcome:"INDETERMINATE",reason:`HORIZON_HTTP_${response.status}`}
    const body:unknown=await response.json().catch(()=>null)
    if(!isRecord(body)||!isRecord(body._embedded)||!Array.isArray(body._embedded.records))return{outcome:"INDETERMINATE",reason:"HORIZON_SHAPE_INVALID"}
    const records=body._embedded.records
    if(records.some(tx=>isRecord(tx)&&tx.successful===true&&tx.memo_type==="text"&&tx.memo===a2uPaymentId))return{outcome:"MOVEMENT_PRESENT",reason:"HORIZON_MEMO_MOVEMENT_PRESENT"}
    if(records.length===0)return{outcome:"ABSENT"}
    const last=records[records.length-1], oldestRaw=isRecord(last)?exact(last.created_at):null, oldest=oldestRaw?Date.parse(oldestRaw):NaN
    if(Number.isFinite(oldest)&&oldest<=stopBefore)return{outcome:"ABSENT"}
    const next=isRecord(body._links)&&isRecord(body._links.next)?exact(body._links.next.href):null
    if(!next||!next.startsWith("https://api.testnet.minepi.com/"))return{outcome:"INDETERMINATE",reason:"HORIZON_PAGINATION_INVALID"}
    url=next
  }
  return{outcome:"INDETERMINATE",reason:"HORIZON_SCAN_BOUND_EXHAUSTED"}
}
