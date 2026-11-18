import {redis,isRedisConfigured} from './redis'
const PREFIX='flashpay:diagnostic:financial:v1:'
export const FINANCIAL_TRACE_RETENTION={payments:64,firstEvents:24,lastEvents:128,milestones:96,ttlSeconds:172800,eventBytes:900} as const
// All keys belong exclusively to disposable diagnostics. Never financial state.
const APPEND=`
local prefix=ARGV[1]; local id=ARGV[2]; local now=tonumber(ARGV[3]); local ttl=172800
local head=prefix..id..':head'; local tail=prefix..id..':tail';local milestones=prefix..id..':milestones'
local count=redis.call('LLEN',head)
for i=4,#ARGV do
 if count<24 then redis.call('RPUSH',head,ARGV[i]); count=count+1 end
 redis.call('RPUSH',tail,ARGV[i])
 if redis.call('HLEN',milestones)<96 then
  local e=cjson.decode(ARGV[i]); local key=tostring(e.phase)..':'..tostring(e.event)
  redis.call('HSETNX',milestones,key,ARGV[i])
 end
end
redis.call('LTRIM',tail,-128,-1)
redis.call('EXPIRE',head,ttl); redis.call('EXPIRE',tail,ttl);redis.call('EXPIRE',milestones,ttl)
redis.call('ZADD',KEYS[1],now,id); redis.call('EXPIRE',KEYS[1],ttl)
local extra=redis.call('ZCARD',KEYS[1])-64
if extra>0 then
 local old=redis.call('ZRANGE',KEYS[1],0,extra-1)
 for _,v in ipairs(old) do redis.call('DEL',prefix..v..':head',prefix..v..':tail',prefix..v..':milestones');redis.call('ZREM',KEYS[1],v) end
end
return 1`
export async function storeFinancialTrace(id:string,events:Record<string,unknown>[]):Promise<void>{
 if(!isRedisConfigured||!/^[A-Za-z0-9_-]{8,128}$/.test(id))return
 const rows=events.slice(0,257).map(e=>JSON.stringify(e)).filter(e=>Buffer.byteLength(e)<=FINANCIAL_TRACE_RETENTION.eventBytes)
 if(!rows.length)return
 await redis.eval(APPEND,[PREFIX+'index'],[PREFIX,id,String(Date.now()),...rows])
}
export async function readFinancialTrace(id:string){
 const retention=FINANCIAL_TRACE_RETENTION
 if(!isRedisConfigured||!/^[A-Za-z0-9_-]{8,128}$/.test(id))return {state:'unavailable',retention,events:[],financialAuthority:false}
 try{
  const [first,last,milestones]=await Promise.all([redis.lrange(PREFIX+id+':head',0,23),redis.lrange(PREFIX+id+':tail',0,127),redis.hvals(PREFIX+id+':milestones')])
  const unique=new Map<string,Record<string,unknown>>()
  for(const raw of [...first,...last,...milestones]){const e=(typeof raw==='string'?JSON.parse(raw):raw) as Record<string,unknown>;if(e&&e.v===1)unique.set(JSON.stringify(e),e)}
  const events=[...unique.values()].sort((a,b)=>String(a.at).localeCompare(String(b.at)))
  return {state:events.length?'available':'absent_or_expired',retention,events,financialAuthority:false,completeHistoryGuaranteed:false}
 }catch{return {state:'unavailable',retention,events:[],financialAuthority:false}}
}
