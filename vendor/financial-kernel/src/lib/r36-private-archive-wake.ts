import 'server-only'
import {createHmac} from 'node:crypto'
import {deployment} from '../deployment'
// Separate housekeeping capability. Never wakes a wallet or runs a payment.
export async function wakePrivateArchive():Promise<void>{
 const env=process.env,origin=deployment().trustOrigin,key=env.R36_HOST_WAKE_SECRET,bypass=env.R36_HOST_DEPLOYMENT_BYPASS
 if(env.R36_HOST_MODE!=='vercel_on_demand'||env.VERCEL_ENV!=='production'||env.R36_HOST_ORIGIN!==origin||!key||!/^[A-Za-z0-9_-]{64}$/.test(key)||!bypass||!/^[A-Za-z0-9_-]{32,512}$/.test(bypass))return
 const raw=JSON.stringify({schema:'R36_ARCHIVE_WAKE_V1'}),stamp=String(Date.now())
 try{
  const r=await fetch(origin+'/api/archive',{method:'POST',body:raw,cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json','x-r36-timestamp':stamp,'x-r36-signature':createHmac('sha256',key).update(stamp+'\n'+raw).digest('hex'),'x-vercel-protection-bypass':bypass},signal:AbortSignal.timeout(55000)})
  const v=await r.json();if(!r.ok||v.financialAuthority!==false)throw Error('ARCHIVE_WAKE_UNAVAILABLE')
  console.info('[R36 archive wake]',{status:v.status,packs:v.packs??0,financialAuthority:false})
 }catch{console.warn('[R36 archive wake]',{status:'retained_for_next_scheduled_wake',financialAuthority:false})}
}
