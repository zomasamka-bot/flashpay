import {deployment} from '../deployment'
import 'server-only'
import {createHmac} from 'node:crypto'
const origin=deployment().trustOrigin
export async function observeIntakePolicy(env:NodeJS.ProcessEnv=process.env,send:typeof fetch=fetch):Promise<boolean>{
 if(env.VERCEL_ENV!=='production'||env.R36_HOST_MODE!=='vercel_on_demand'||env.R36_HOST_ORIGIN!==origin)return false
 const key=env.R36_HOST_WAKE_SECRET,policy=env.R36_SCOPED_POLICY_DIGEST,protection=env.R36_HOST_DEPLOYMENT_BYPASS
 if(!key||! /^[A-Za-z0-9_-]{64}$/.test(key)||!policy||! /^[0-9a-f]{64}$/.test(policy)||!protection||! /^[A-Za-z0-9_-]{32,512}$/.test(protection))return false
 try{
  const body=JSON.stringify({schema:'R36_PRIVATE_INTAKE_V1'}),stamp=String(Date.now())
  const r=await send(origin+'/api/intake',{method:'POST',body,headers:{'Content-Type':'application/json','x-r36-timestamp':stamp,'x-r36-signature':createHmac('sha256',key).update(stamp+'\n'+body).digest('hex'),'x-vercel-protection-bypass':protection},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)})
  if(!r.ok)return false
  const v=await r.json();return v?.ready===true&&v.phase==='REGISTRY_READY'&&v.policyDigest===policy&&v.financialAuthority===false&&v.networkFinality===false
 }catch{return false}
}
