import {deployment} from '../deployment'
import 'server-only'
import {redis} from './redis'

type Ports={env:NodeJS.ProcessEnv;select:()=>Promise<string|null>;claim:(id:string)=>Promise<boolean>;send:typeof fetch}
export async function continueConfirmedSettlement(p:Ports):Promise<string>{
 if(p.env.VERCEL_ENV!=='production'||p.env.FLASHPAY_RECOVERY_SCOPE!=='admitted_new')return 'disabled'
 const secret=p.env.FLASHPAY_TRANSIENT_RECOVERY_SECRET
 if(!secret)return 'unconfigured'
 const id=await p.select()
 if(!id)return 'no_confirmed_work'
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))return 'invalid_identity'
 if(!await p.claim(id))return 'bounded_or_coalesced'
 // Notification only. The original endpoint repeats authentication, cutover,
 // service readiness and SQL authority selection. No executor is called here.
 const response=await p.send((deployment().publicOrigin+'/api/recovery/new-intents?paymentId=')+id,{
  method:'POST',headers:{'x-flashpay-transient-recovery-secret':secret},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(90000)})
 return response.ok?'delivered':'receiver_held'
}
export async function claimConfirmedFollowup(id:string):Promise<boolean>{
 return Number(await redis.eval(`
local n=tonumber(redis.call('GET',KEYS[1]) or '0')
if n>=3 then return 0 end
if not redis.call('SET',KEYS[2],'1','NX','EX',5) then return 0 end
n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end
return 1`,['flashpay:r36:confirmed-followup:'+id,'flashpay:r36:confirmed-followup-lease:'+id],[]))===1
}
