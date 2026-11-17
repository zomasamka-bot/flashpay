import 'server-only'
import {redis,isRedisConfigured} from './redis'
const key='flashpay:recovery:pi-create-backpressure:v1'
// Operational throttling only: an expired wait never rearms a consumed claim.
export async function piCreateCooldown():Promise<'READY'|'WAIT'|'UNAVAILABLE'>{
 if(!isRedisConfigured)return 'UNAVAILABLE'
 try{
  const value=await redis.get<unknown>(key)
  if(value===null)return 'READY'
  const until=typeof value==='number'?value:typeof value==='string'&&/^[0-9]+$/.test(value)?Number(value):NaN
  if(!Number.isSafeInteger(until)||until<0)return 'UNAVAILABLE'
  return until>Date.now()?'WAIT':'READY'
 }catch{return 'UNAVAILABLE'}
}
export async function recordPiCreateCooldown(retryAfter:string|null):Promise<boolean>{
 const now=Date.now(),seconds=retryAfter!==null&&/^[0-9]+$/.test(retryAfter)?Number(retryAfter):NaN
 const date=retryAfter?Date.parse(retryAfter):NaN
 const requested=Number.isSafeInteger(seconds)&&seconds>=0?now+seconds*1000:date
 const until=Math.max(now+15*60_000,Number.isFinite(requested)?Math.min(requested,now+86_400_000):0)
 try{
  const result=await redis.eval<[string,string],number>(`
local n=tonumber(ARGV[1]); local now=tonumber(ARGV[2]); local old=redis.call('GET',KEYS[1])
if old then local v=tonumber(old); if not v then return -1 end; if v>n then n=v end end
redis.call('SET',KEYS[1],tostring(n),'PX',math.ceil(n-now)); return n`,[key],[String(until),String(now)])
  return Number.isSafeInteger(result)&&result>=until
 }catch{return false}
}
