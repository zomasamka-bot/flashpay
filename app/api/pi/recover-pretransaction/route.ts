import { type NextRequest, NextResponse } from "next/server"
import { serverConfig } from "@/lib/server-config"
import { ensureSettlementCheckpointTable, readSettlementU2APretransactionRecoveryCandidate, retireSettlementU2AApprovalAfterCanonicalCancellation } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type PiPayment = { identifier?:unknown; user_uid?:unknown; amount?:unknown; direction?:unknown; network?:unknown; created_at?:unknown; from_address?:unknown; metadata?:{paymentId?:unknown}; status?:{developer_approved?:unknown;transaction_verified?:unknown;developer_completed?:unknown;cancelled?:unknown;user_cancelled?:unknown}; transaction?:null|{txid?:unknown;verified?:unknown} }

function exactPretransaction(pi:PiPayment, paymentId:string, piPaymentId:string, amount:number) {
  return pi.identifier===piPaymentId && pi.metadata?.paymentId===paymentId && pi.network==='Pi Testnet' && pi.direction==='user_to_app' &&
    pi.amount===amount && pi.status?.developer_approved===true && pi.status?.transaction_verified===false &&
    pi.status?.developer_completed===false && pi.transaction==null
}
async function getPi(id:string):Promise<{ok:true;pi:PiPayment}|{ok:false}> {
  try { const r=await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(id)}`,{headers:{Authorization:`Key ${serverConfig.piApiKey}`,'Content-Type':'application/json'},cache:'no-store'}); if(!r.ok)return{ok:false}; return{ok:true,pi:await r.json()} } catch{return{ok:false}}
}

type HorizonAbsence = {outcome:'ABSENT'}|{outcome:'MOVEMENT_PRESENT'|'INDETERMINATE';error:string}
async function proveHorizonAbsence(pi:PiPayment, piPaymentId:string):Promise<HorizonAbsence> {
  const source=typeof pi.from_address==='string'?pi.from_address.trim():''
  const created=typeof pi.created_at==='string'?Date.parse(pi.created_at):NaN
  if(!/^G[A-Z2-7]{55}$/.test(source)||!Number.isFinite(created))return{outcome:'INDETERMINATE',error:'Canonical source/time unavailable'}
  const stopBefore=created-5*60*1000
  let url=`https://api.testnet.minepi.com/accounts/${encodeURIComponent(source)}/transactions?order=desc&limit=200&include_failed=true`
  for(let page=0;page<20;page++) {
    let response:Response
    try { response=await fetch(url,{cache:'no-store'}) } catch { return{outcome:'INDETERMINATE',error:'Horizon read failed'} }
    if(!response.ok)return{outcome:'INDETERMINATE',error:`Horizon read ${response.status}`}
    const body=await response.json().catch(()=>null); const records=body?._embedded?.records
    if(!Array.isArray(records))return{outcome:'INDETERMINATE',error:'Horizon response invalid'}
    if(records.some((tx:any)=>tx?.successful===true&&tx?.memo_type==='text'&&tx?.memo===piPaymentId))return{outcome:'MOVEMENT_PRESENT',error:'Horizon transaction exists for Pi payment identifier'}
    if(records.length===0)return{outcome:'ABSENT'}
    const oldest=Date.parse(String(records[records.length-1]?.created_at??''))
    if(Number.isFinite(oldest)&&oldest<=stopBefore)return{outcome:'ABSENT'}
    const next=body?._links?.next?.href
    if(typeof next!=='string'||!next.startsWith('https://api.testnet.minepi.com/'))return{outcome:'INDETERMINATE',error:'Horizon pagination unavailable'}
    url=next
  }
  return{outcome:'INDETERMINATE',error:'Horizon absence scan bound exhausted'}
}

export async function POST(request:NextRequest) {
  try {
    const body=await request.json().catch(()=>null)
    const paymentId=typeof body?.paymentId==='string'?body.paymentId.trim():''
    const piPaymentId=typeof body?.piPaymentId==='string'?body.piPaymentId.trim():''
    const accessToken=typeof body?.accessToken==='string'?body.accessToken.trim():''
    if(!paymentId||!piPaymentId||!accessToken)return NextResponse.json({error:'Recovery identity/authentication missing',code:'U2A_PRETX_RECOVERY_INPUT_INVALID'},{status:400})
    if(!serverConfig.isPiApiKeyConfigured)return NextResponse.json({error:'Recovery unavailable',code:'U2A_PRETX_RECOVERY_UNAVAILABLE'},{status:503})
    if(!(await ensureSettlementCheckpointTable()))return NextResponse.json({error:'Recovery durability unavailable',code:'U2A_PRETX_RECOVERY_DB_UNAVAILABLE'},{status:503})

    const me=await fetch('https://api.minepi.com/v2/me',{headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},cache:'no-store'}).catch(()=>null)
    if(!me?.ok)return NextResponse.json({error:'Pi authentication rejected',code:'U2A_PRETX_RECOVERY_AUTH_REJECTED'},{status:401})
    const meBody=await me.json().catch(()=>null); const uid=typeof meBody?.uid==='string'?meBody.uid.trim():''
    if(!uid)return NextResponse.json({error:'Pi authentication invalid',code:'U2A_PRETX_RECOVERY_AUTH_INVALID'},{status:401})

    const candidate=await readSettlementU2APretransactionRecoveryCandidate(paymentId,piPaymentId)
    if(candidate.outcome!=='CANDIDATE')return NextResponse.json({error:'Payment is not safely recoverable',code:candidate.outcome==='INDETERMINATE'?'U2A_PRETX_RECOVERY_INDETERMINATE':'U2A_PRETX_RECOVERY_NOT_CANDIDATE'},{status:candidate.outcome==='INDETERMINATE'?503:409})

    const before=await getPi(piPaymentId)
    if(!before.ok)return NextResponse.json({error:'Pi state unavailable',code:'U2A_PRETX_PI_READ_UNAVAILABLE'},{status:503})
    if(!exactPretransaction(before.pi,paymentId,piPaymentId,candidate.customerAmount) || before.pi.user_uid!==uid)
      return NextResponse.json({error:'Canonical Pi state does not permit pre-transaction recovery',code:'U2A_PRETX_CANONICAL_MISMATCH'},{status:409})
    const horizonBefore=await proveHorizonAbsence(before.pi,piPaymentId)
    if(horizonBefore.outcome!=='ABSENT')return NextResponse.json({error:'Independent blockchain absence not proven',code:horizonBefore.outcome==='MOVEMENT_PRESENT'?'U2A_PRETX_HORIZON_MOVEMENT_PRESENT':'U2A_PRETX_HORIZON_INDETERMINATE'},{status:409})

    // Replay after an ambiguous prior request: if Pi already proves cancelled and still has no transaction,
    // skip the mutation and finish the durable retirement idempotently.
    const alreadyCancelled=before.pi.status?.cancelled===true || before.pi.status?.user_cancelled===true
    if(!alreadyCancelled) {
      try { await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(piPaymentId)}/cancel`,{method:'POST',headers:{Authorization:`Key ${serverConfig.piApiKey}`,'Content-Type':'application/json'}}) } catch { /* outcome is intentionally reconciled below */ }
    }

    // Mandatory exact reconciliation after every cancel outcome. Never infer success from POST response.
    const after=await getPi(piPaymentId)
    if(!after.ok)return NextResponse.json({error:'Cancellation reconciliation unavailable',code:'U2A_PRETX_CANCEL_RECONCILIATION_UNAVAILABLE'},{status:503})
    if(!exactPretransaction(after.pi,paymentId,piPaymentId,candidate.customerAmount) || after.pi.user_uid!==uid ||
       (after.pi.status?.cancelled!==true && after.pi.status?.user_cancelled!==true))
      return NextResponse.json({error:'Cancellation not safely proven',code:'U2A_PRETX_CANCEL_NOT_PROVEN'},{status:409})
    const horizonAfter=await proveHorizonAbsence(after.pi,piPaymentId)
    if(horizonAfter.outcome!=='ABSENT')return NextResponse.json({error:'Post-cancel blockchain absence not proven',code:horizonAfter.outcome==='MOVEMENT_PRESENT'?'U2A_PRETX_HORIZON_MOVEMENT_PRESENT':'U2A_PRETX_HORIZON_INDETERMINATE'},{status:409})

    const retired=await retireSettlementU2AApprovalAfterCanonicalCancellation({paymentId,piPaymentId,piCancelledAt:new Date().toISOString()})
    if(retired.outcome!=='RETIRED'&&retired.outcome!=='REPLAYED')return NextResponse.json({error:'Durable retirement unavailable',code:retired.outcome==='INDETERMINATE'?'U2A_PRETX_RETIREMENT_INDETERMINATE':'U2A_PRETX_RETIREMENT_CONFLICT'},{status:retired.outcome==='INDETERMINATE'?503:409})
    console.log('[R4J U2A PRETRANSACTION RECOVERY]',{paymentId,piPaymentId,outcome:retired.outcome,version:retired.version,piCancelled:true,transactionPresent:false})
    return NextResponse.json({success:true,retryAllowed:true,outcome:retired.outcome})
  } catch(error) {
    console.error('[R4J U2A PRETRANSACTION RECOVERY] failed closed',error)
    return NextResponse.json({error:'Recovery unavailable',code:'U2A_PRETX_RECOVERY_UNAVAILABLE'},{status:503})
  }
}
