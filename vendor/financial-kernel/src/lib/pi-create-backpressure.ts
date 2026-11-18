import 'server-only'
import {redis,isRedisConfigured} from './redis'
const key='flashpay:recovery:pi-create-backpressure:v1'
export async function piCreateCooldown():Promise<'READY'|'WAIT'|'UNAVAILABLE'>{
 if(!isRedisConfigured)return 'UNAVAILABLE'
 try{const v=await redis.get<unknown>(key);if(v===null)return 'READY'
 const until=typeof v==='number'?v:typeof v==='string'&&/^[0-9]+$/.test(v)?Number(v):NaN
 return Number.isSafeInteger(until)&&until>=0?(until>Date.now()?'WAIT':'READY'):'UNAVAILABLE'
 }catch{return 'UNAVAILABLE'}
}
// App-scoped provider rejection remains app-scoped. Respect explicit Retry-After;
// otherwise back off 30s..15m with jitter. This never grants financial authority.
export async function recordPiCreateCooldown(retryAfter:string|null):Promise<boolean>{
 const now=Date.now(),seconds=retryAfter!==null&&/^[0-9]+$/.test(retryAfter)?Number(retryAfter):NaN
 const requested=Number.isSafeInteger(seconds)&&seconds>=0?now+seconds*1000:retryAfter?Date.parse(retryAfter):NaN
 try{
 const until=await redis.eval<[string,string,string],number>(`
 local now=tonumber(ARGV[1]); local requested=tonumber(ARGV[2]); local n=redis.call('INCR',KEYS[2]);redis.call('EXPIRE',KEYS[2],1800)
 local delay=math.min(900000,30000*2^math.min(n-1,5))+tonumber(ARGV[3])
 local target=requested>0 and math.max(now+1000,requested) or now+delay
 local old=redis.call('GET',KEYS[1]); if old then local v=tonumber(old);if not v then return -1 end;target=math.max(target,v) end
 redis.call('SET',KEYS[1],tostring(target),'PX',math.ceil(target-now));return target`,[key,key+':failures'],[String(now),String(Number.isSafeInteger(requested)?requested:0),String(Math.floor(Math.random()*1000))])
 return Number.isSafeInteger(until)&&until>now
 }catch{return false}
}
