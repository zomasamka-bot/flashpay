import {after,NextRequest,NextResponse} from "next/server"
import {verifyOwnerAuthorizationHeader} from "@flashpay/financial-kernel/lib/owner-server-auth"
import {GET as recover} from "@flashpay/financial-kernel/handlers/recovery/new-intents/route"
import {redis,isRedisConfigured} from "@flashpay/financial-kernel/lib/redis"
import {OPERATIONAL_AUDIT_KEY,OPERATIONAL_AUDIT_MAX_EVENTS} from "@flashpay/financial-kernel/lib/operational-audit"
import {readLimitedText} from "@/lib/limited-request"
export const runtime="nodejs"
export const dynamic="force-dynamic"
export const maxDuration=300
const key="flashpay:owner-recovery-wake:v1"
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}})
export async function GET(req:NextRequest){
 const auth=await verifyOwnerAuthorizationHeader(req.headers.get('authorization'));if(!auth.ok)return reply({error:'UNAUTHORIZED'},auth.status)
 try{return reply({last:await redis.get(key+':last')})}catch{return reply({error:'RECOVERY_STATUS_UNAVAILABLE'},503)}
}
export async function POST(req:NextRequest){
 const auth=await verifyOwnerAuthorizationHeader(req.headers.get('authorization'));if(!auth.ok)return reply({error:'UNAUTHORIZED'},auth.status)
 if(req.headers.get('origin')&&req.headers.get('origin')!==req.nextUrl.origin)return reply({error:'ORIGIN_REJECTED'},403)
 if(req.nextUrl.search)return reply({error:'INVALID_SCOPE'},400)
 if(!isRedisConfigured||!process.env.CRON_SECRET||process.env.FLASHPAY_RECOVERY_SCOPE!=='admitted_new')return reply({error:'RECOVERY_UNAVAILABLE'},503)
 try{
  const body=JSON.parse(await readLimitedText(req,1200))
  if(Object.keys(body).sort().join(',')!=='action,reason'||body.action!=='wake'||typeof body.reason!=='string'||!body.reason.trim()||body.reason.trim().length>240)return reply({error:'INVALID_SCOPE'},400)
  const accepted=await redis.set(key+':cooldown','1',{nx:true,ex:300})
  if(!accepted)return reply({error:'RECOVERY_ALREADY_REQUESTED'},429)
  const requestId=crypto.randomUUID(),requestedAt=new Date().toISOString(),reason=body.reason.trim()
  await redis.lpush(OPERATIONAL_AUDIT_KEY,JSON.stringify({eventId:requestId,requestId,actorUid:auth.uid,action:'recovery.wake',createdAt:Date.now(),reason}))
  await redis.ltrim(OPERATIONAL_AUDIT_KEY,0,OPERATIONAL_AUDIT_MAX_EVENTS-1)
  await redis.set(key+':last',{requestId,requestedAt,state:'requested'},{ex:86400})
  after(async()=>{
   try{
    // Same bounded scheduled handler, including cutover, certificates, locks,
    // One-Shot and XOR. No payment ID, amount or final status from the owner.
    const response=await recover(new NextRequest(new URL('/api/recovery/new-intents',req.url),{headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`}}))
    await redis.set(key+':last',{requestId,requestedAt,finishedAt:new Date().toISOString(),state:response.ok?'checked':'unavailable',status:response.status},{ex:86400})
   }catch{await redis.set(key+':last',{requestId,requestedAt,finishedAt:new Date().toISOString(),state:'unavailable'},{ex:86400}).catch(()=>{})}
  })
  return reply({accepted:true,requestId,requestedAt,financialOutcome:'not_asserted'},202)
 }catch(e){return reply({error:e instanceof SyntaxError?'INVALID_SCOPE':'RECOVERY_UNAVAILABLE'},e instanceof SyntaxError?400:503)}
}
