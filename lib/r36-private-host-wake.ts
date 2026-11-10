import 'server-only'
import {createHmac} from 'node:crypto'

type Reason='creation'|'payer'|'approval'|'completion'|'recovery'
type Ports={env:()=>NodeJS.ProcessEnv;send:typeof fetch;now:()=>number}
const origin='https://flashpay-r36-private-control-hazema-abo-rias-projects.vercel.app'

// This is a wake capability, never a financial permission or a certificate.
// No payment, wallet, XDR or credential may be supplied by the HTTP caller.
export function createPrivateHostWake(ports:Ports){
 let pending:Promise<boolean>|null=null
 let freshUntil=0, freshPolicy=''
 async function wake(reason:Reason):Promise<boolean>{
  const env=ports.env()
  if(!env.R36_HOST_MODE)return true // Existing qualified local service mode.
  if(env.R36_HOST_MODE!=='vercel_on_demand'||env.VERCEL_ENV!=='production'||env.R36_HOST_ORIGIN!==origin)return false
  const key=env.R36_HOST_WAKE_SECRET,policy=env.R36_SCOPED_POLICY_DIGEST
  if(!key||!/^[A-Za-z0-9_-]{64}$/.test(key)||!policy||!/^[0-9a-f]{64}$/.test(policy))return false
  // Completed checkpoint progress must reach the producer even inside the
  // short readiness cache. This is an operational wake, never a cached right.
  if(reason!=='completion'&&ports.now()<freshUntil&&freshPolicy===policy)return true
  try{
   const protection=env.R36_HOST_DEPLOYMENT_BYPASS;if(!protection||protection.length<32||protection.length>512||!/^[A-Za-z0-9_-]+$/.test(protection))return false
   const body=JSON.stringify({schema:'R36_PRIVATE_WAKE_V1',reason}),stamp=String(ports.now())
   const response=await ports.send(origin+'/api/wake',{
    method:'POST',body,headers:{'Content-Type':'application/json','x-r36-timestamp':stamp,
     'x-r36-signature':createHmac('sha256',key).update(stamp+'\n'+body).digest('hex'),
     'x-vercel-protection-bypass':protection},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(55000)
   })
   if(!response.ok)return false
   const value=await response.json()
   if(value?.ready!==true||value.phase!=='EVIDENCE_READY'||value.financialAuthority!==false||value.policyDigest!==policy)return false
   freshPolicy=policy;freshUntil=ports.now()+5000;return true
  }catch{return false}
 }
 return async(reason:Reason)=>{
  if(pending)return pending
  pending=wake(reason);try{return await pending}finally{pending=null}
 }
}
export const ensurePrivateTrustHost=createPrivateHostWake({env:()=>process.env,send:(...args)=>fetch(...args),now:()=>Date.now()})
