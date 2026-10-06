import { type NextRequest, NextResponse } from "next/server"
import { fin4AuthorizeRunId } from "@/lib/fin4-live-certification"
import { query, readSettlementU2APretransactionRecoveryCandidate, retireSettlementU2AApprovalAfterCanonicalCancellation } from "@/lib/db"
import { serverConfig } from "@/lib/server-config"

export const dynamic="force-dynamic"
export const runtime="nodejs"
export const maxDuration=90
const PAYMENT_ID="a0553edf-8784-4758-a246-2da36847a3b8"
const PI_PAYMENT_ID="JYJ36kpTyzUPuEFd0uJIWAynLCJK"
type Row=Record<string,unknown>
const rec=(v:unknown):v is Row=>typeof v==="object"&&v!==null&&!Array.isArray(v)

async function getPi():Promise<Row|null>{
  try{
    const r=await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(PI_PAYMENT_ID)}`,{headers:{Authorization:`Key ${serverConfig.piApiKey}`},cache:"no-store"})
    if(!r.ok)return null
    const b:unknown=await r.json().catch(()=>null)
    return rec(b)?b:null
  }catch{return null}
}
async function horizonAbsence(pi:Row):Promise<"ABSENT"|"MOVEMENT_PRESENT"|"INDETERMINATE">{
  const source=typeof pi.from_address==="string"?pi.from_address.trim():""
  const created=typeof pi.created_at==="string"?Date.parse(pi.created_at):NaN
  if(!/^G[A-Z2-7]{55}$/.test(source)||!Number.isFinite(created))return"INDETERMINATE"
  const stop=created-300000
  let url=`https://api.testnet.minepi.com/accounts/${encodeURIComponent(source)}/transactions?order=desc&limit=200&include_failed=true`
  for(let page=0;page<20;page++){
    let r:Response;try{r=await fetch(url,{cache:"no-store"})}catch{return"INDETERMINATE"}
    if(!r.ok)return"INDETERMINATE"
    const b:any=await r.json().catch(()=>null), rows=b?._embedded?.records
    if(!Array.isArray(rows))return"INDETERMINATE"
    if(rows.some((tx:any)=>tx?.successful===true&&tx?.memo_type==="text"&&tx?.memo===PI_PAYMENT_ID))return"MOVEMENT_PRESENT"
    if(rows.length===0)return"ABSENT"
    const oldest=Date.parse(String(rows[rows.length-1]?.created_at??""))
    if(Number.isFinite(oldest)&&oldest<=stop)return"ABSENT"
    const next=b?._links?.next?.href
    if(typeof next!=="string"||!next.startsWith("https://api.testnet.minepi.com/"))return"INDETERMINATE"
    url=next
  }
  return"INDETERMINATE"
}
export async function POST(request:NextRequest){
  const runId=fin4AuthorizeRunId(request.headers.get("x-flashpay-fin4-run-id"))
  if(!runId)return NextResponse.json({error:"Unauthorized"},{status:403})
  if(!serverConfig.isPiApiKeyConfigured)return NextResponse.json({ok:false,outcome:"PI_READ_UNAVAILABLE",financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false},{status:503})

  const candidate=await readSettlementU2APretransactionRecoveryCandidate(PAYMENT_ID,PI_PAYMENT_ID)
  if(candidate.outcome!=="CANDIDATE")return NextResponse.json({ok:false,outcome:"DURABLE_PRECONDITION_NOT_PROVEN",candidateOutcome:candidate.outcome,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false},{status:409})

  const pi=await getPi(), status=pi&&rec(pi.status)?pi.status:null, metadata=pi&&rec(pi.metadata)?pi.metadata:null
  const exact=Boolean(pi&&status&&metadata&&pi.identifier===PI_PAYMENT_ID&&pi.network==="Pi Testnet"&&pi.direction==="user_to_app"&&pi.amount===candidate.customerAmount&&typeof pi.user_uid==="string"&&pi.user_uid.trim()!==""&&metadata.paymentId===PAYMENT_ID&&status.developer_approved===true&&status.transaction_verified===false&&status.developer_completed===false&&status.cancelled===true&&status.user_cancelled===false&&pi.transaction==null)
  if(!exact)return NextResponse.json({ok:false,outcome:"PI_EXACT_CANCELLED_PRETRANSACTION_NOT_PROVEN",financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false},{status:409})

  const h=await horizonAbsence(pi!)
  if(h!=="ABSENT")return NextResponse.json({ok:false,outcome:"HORIZON_ABSENCE_NOT_PROVEN",horizonOutcome:h,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false},{status:409})

  // C is already canonically cancelled: deliberately no Pi cancel POST.
  const retired=await retireSettlementU2AApprovalAfterCanonicalCancellation({paymentId:PAYMENT_ID,piPaymentId:PI_PAYMENT_ID,piCancelledAt:new Date().toISOString()})
  if(retired.outcome!=="RETIRED"&&retired.outcome!=="REPLAYED")return NextResponse.json({ok:false,outcome:"DURABLE_RETIREMENT_NOT_PROVEN",durableOutcome:retired.outcome,financialAuthorityMutated:retired.outcome==="INDETERMINATE",piMutationExecuted:false,horizonSubmitExecuted:false},{status:retired.outcome==="INDETERMINATE"?503:409})

  const post=await query(`SELECT stage,u2a_approval_identifier,u2a_approval_claimed_at,u2a_identifier,u2a_txid,a2u_payment_id,prepared_tx_hash,a2u_txid,horizon_confirmed_at,EXISTS(SELECT 1 FROM settlement_u2a_approval_retirements r WHERE r.payment_id=$1 AND r.pi_payment_id=$2 AND r.reason='pi_pretransaction_cancelled') AS retirement_evidence FROM settlement_checkpoints WHERE payment_id=$1`,[PAYMENT_ID,PI_PAYMENT_ID])
  const p=Array.isArray(post)&&post.length===1?post[0] as Row:null
  const postOk=Boolean(p&&p.stage==="payment_identity"&&p.u2a_approval_identifier==null&&p.u2a_approval_claimed_at==null&&p.u2a_identifier==null&&p.u2a_txid==null&&p.a2u_payment_id==null&&p.prepared_tx_hash==null&&p.a2u_txid==null&&p.horizon_confirmed_at==null&&p.retirement_evidence===true)
  return NextResponse.json({ok:postOk,action:"r4t63-retire-c",runId,paymentId:PAYMENT_ID,piPaymentId:PI_PAYMENT_ID,piExactCancelledPretransaction:true,horizonAbsenceProven:true,durableOutcome:retired.outcome,durablePostconditionProven:postOk,financialAuthorityMutated:true,piMutationExecuted:false,horizonSubmitExecuted:false,refundMutationExecuted:false},{status:postOk?200:503})
}
