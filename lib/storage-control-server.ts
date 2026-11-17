import 'server-only'
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto'
import {deployment} from '@flashpay/financial-kernel/deployment'
import {serverConfig} from '@flashpay/financial-kernel/lib/server-config'
export type StorageSnapshot=Record<string,any>
let cached:{until:number,value:StorageSnapshot}|null=null
let flight:Promise<StorageSnapshot>|null=null
const key=()=>{const k=process.env.R36_HOST_WAKE_SECRET;if(!k||!/^[A-Za-z0-9_-]{64}$/.test(k))throw Error('STORAGE_UNAVAILABLE');return k}
export async function privateStorage(action:string,extra:Record<string,string>={}):Promise<StorageSnapshot>{
 const origin=deployment().trustOrigin,env=process.env
 if(env.R36_HOST_MODE!=='vercel_on_demand'||env.VERCEL_ENV!=='production'||env.R36_HOST_ORIGIN!==origin||!env.R36_HOST_DEPLOYMENT_BYPASS)throw Error('STORAGE_UNAVAILABLE')
 const raw=JSON.stringify({schema:'R36_STORAGE_CONTROL_V1',action,...extra}),stamp=String(Date.now())
 const r=await fetch(origin+'/api/storage',{method:'POST',body:raw,cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json','x-r36-timestamp':stamp,'x-r36-signature':createHmac('sha256',key()).update(stamp+'\n'+raw).digest('hex'),'x-vercel-protection-bypass':env.R36_HOST_DEPLOYMENT_BYPASS},signal:AbortSignal.timeout(20000)})
 const value=await r.json();if(!r.ok||value.financialAuthority!==false)throw Error(r.status===409?'PREVIEW_CHANGED':'STORAGE_UNAVAILABLE');return value
}
async function redisStorage(){
 try{
  if(!serverConfig.isRedisConfigured)throw Error('UNAVAILABLE')
  const r=await fetch(serverConfig.redisUrl,{method:'POST',headers:{Authorization:`Bearer ${serverConfig.redisToken}`,'Content-Type':'application/json'},body:JSON.stringify(['INFO','MEMORY']),cache:'no-store',signal:AbortSignal.timeout(5000)})
  const v=await r.json();if(!r.ok||typeof v.result!=='string')throw Error('UNAVAILABLE')
  const n=(k:string)=>{const m=v.result.match(new RegExp('(?:^|\\n)'+k+':([0-9]+)'));return m?Number(m[1]):null}
  const bytes=n('used_memory'),limit=n('maxmemory');return {status:bytes===null?'unknown':'observed',bytes,limitBytes:limit&&limit>0?limit:null,limitStatus:'runtime_limit_not_provider_quota'}
 }catch{return {status:'unknown',bytes:null,limitBytes:null,reason:'metrics_unavailable'}}
}
export async function storageStatus(fresh=false):Promise<StorageSnapshot>{
 if(!fresh&&cached&&cached.until>Date.now())return cached.value
 if(!fresh&&flight)return flight
 const read=async()=>{const [v,redis]=await Promise.all([privateStorage('status'),redisStorage()]);const value={...v,redis,trustStorage:v.trustStorage??{status:'unknown',bytes:null,limitBytes:null,reason:'metric_unavailable'}};cached={until:Date.now()+30000,value};return value}
 if(fresh)return read();flight=read();try{return await flight}finally{flight=null}
}
export function issueCleanupTicket(uid:string,digest:string){
 const t={id:randomUUID(),digest,expiresAt:Date.now()+300000};const raw=JSON.stringify({...t,uid});return {...t,token:createHmac('sha256',key()).update('storage-cleanup-v1\n'+raw).digest('hex')}
}
export function verifyCleanupTicket(uid:string,t:any):boolean{
 if(!t||Object.keys(t).sort().join(',')!=='digest,expiresAt,id,token'||!/^[-0-9a-f]{36}$/.test(t.id)||!/^[a-f0-9]{64}$/.test(t.digest)||!/^[a-f0-9]{64}$/.test(t.token)||!Number.isSafeInteger(t.expiresAt)||t.expiresAt<Date.now()||t.expiresAt>Date.now()+300000)return false
 const raw=JSON.stringify({id:t.id,digest:t.digest,expiresAt:t.expiresAt,uid});return timingSafeEqual(Buffer.from(t.token,'hex'),createHmac('sha256',key()).update('storage-cleanup-v1\n'+raw).digest())
}
export function invalidateStorageStatus(){cached=null}
