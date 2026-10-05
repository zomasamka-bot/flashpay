import {type NextRequest,NextResponse} from 'next/server'
import {fin4AuthorizeRunId} from '@/lib/fin4-live-certification'
import {resolveFin4R4TSourceWallet} from '@/lib/fin4-r4t-source-wallet'

export const dynamic='force-dynamic'
export const runtime='nodejs'
export const maxDuration=20

const CONTENDER_COUNT=8
const HOLDER_SETTLE_MS=1000

type ProbeResult={
 processId?:string
 acquired?:boolean
 ok?:boolean
 lockDiagnostic?:{state?:string;ttlSeconds?:number|null}
 sourceWallet?:string
 financialMovementExecuted?:boolean
}

async function postProbe(origin:string,path:string,runId:string):Promise<ProbeResult>{
 const response=await fetch(`${origin}${path}`,{
  method:'POST',
  headers:{'x-flashpay-fin4-run-id':runId,'content-type':'application/json'},
  cache:'no-store',
 })
 return await response.json() as ProbeResult
}

export async function POST(request:NextRequest){
 const runId=fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'))
 if(!runId)return NextResponse.json({error:'Unauthorized'},{status:403})
 const resolved=await resolveFin4R4TSourceWallet()
 if(!resolved.ok)return NextResponse.json({...resolved,runId,financialMovementExecuted:false},{status:409})

 const origin=request.nextUrl.origin
 const holderPromise=postProbe(origin,'/api/certification/fin4-r4t-lock-holder',runId)
 await new Promise(r=>setTimeout(r,HOLDER_SETTLE_MS))
 const contenders=await Promise.all(Array.from({length:CONTENDER_COUNT},()=>
  postProbe(origin,'/api/certification/fin4-r4t-lock-contender',runId)
 ))
 const holder=await holderPromise

 const exactWallet=(x:ProbeResult)=>x.sourceWallet===resolved.sourceWallet
 const distinctBlocked=holder.ok===true?contenders.filter(c=>
  exactWallet(c)&&
  typeof c.processId==='string'&&
  c.processId!==holder.processId&&
  c.acquired===false&&
  c.lockDiagnostic?.state==='busy'&&
  c.financialMovementExecuted===false
 ):[]
 const allBlockedWhileHeld=holder.ok===true&&exactWallet(holder)&&contenders.every(c=>
  exactWallet(c)&&c.acquired===false&&c.lockDiagnostic?.state==='busy'&&c.financialMovementExecuted===false
 )
 const distinctInstanceProven=allBlockedWhileHeld&&distinctBlocked.length>0

 return NextResponse.json({
  ok:distinctInstanceProven,
  action:'fin4-r4t-cross-instance-lock-proof',
  runId,
  paymentB:resolved.paymentB,
  sourceWallet:resolved.sourceWallet,
  sourceWalletAuthority:resolved.authority,
  contenderCount:CONTENDER_COUNT,
  holder,
  contenders,
  allBlockedWhileHeld,
  distinctInstanceProven,
  distinctBlockedCount:distinctBlocked.length,
  distinctBlockedProcessIds:[...new Set(distinctBlocked.map(c=>c.processId))],
  financialMovementExecuted:false,
  piMutationExecuted:false,
  horizonSubmitExecuted:false,
  financialAuthorityMutated:false,
 })
}
