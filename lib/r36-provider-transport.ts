/** Executable mTLS, pinned HTTPS ports. No arbitrary URL, redirect or finance endpoint.
 * Config is deployment/operator input, never an HTTP caller's input. No key fallback.
 */
import https from 'node:https'
import {checkServerIdentity} from 'node:tls'
import {X509Certificate,createHash} from 'node:crypto'
import {R36_WORKER_KINDS,type R36WorkerPorts} from './r36-certificate-worker'
import type {R36CertificateResult} from './r36-certificate-consumer'
export type R36ProviderEndpoint={origin:string;serverSpkiSha256:string;caPem:string;clientCertPem:string;clientKeyPem:string}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
function endpoint(c:R36ProviderEndpoint){
 const v={...c},u=new URL(v.origin)
 if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||/^(?:.*\.)?(?:minepi\.com|vercel\.app|neon\.tech|upstash\.io)$/i.test(u.hostname)||!/^[0-9a-f]{64}$/.test(v.serverSpkiSha256)||![v.caPem,v.clientCertPem,v.clientKeyPem].every(x=>typeof x==='string'&&x.length>0))throw Error('PROVIDER_ENDPOINT_NOT_ALLOWED')
 return{config:v,url:u}
}
const request=(target:ReturnType<typeof endpoint>,path:string,method:'GET'|'POST',body:unknown,signal:AbortSignal,timeout=8000):Promise<unknown>=>new Promise((resolve,reject)=>{
  const payload=body===undefined?undefined:Buffer.from(JSON.stringify(body));let settled=false
  const done=(error:Error|null,result?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);error?reject(Error('PROVIDER_REQUEST_FAILED')):resolve(result)}
  const req=https.request(new URL(path,target.url),{method,agent:false,ca:target.config.caPem,cert:target.config.clientCertPem,key:target.config.clientKeyPem,rejectUnauthorized:true,checkServerIdentity:(host,cert)=>{
   const invalid=checkServerIdentity(host,cert);if(invalid)return invalid
   try{const key=new X509Certificate(cert.raw).publicKey.export({type:'spki',format:'der'});if(sha(key)!==target.config.serverSpkiSha256)return Error('PROVIDER_PIN_MISMATCH')}catch{return Error('PROVIDER_CERTIFICATE_INVALID')}
  },headers:{accept:'application/json',...(payload?{'content-type':'application/json','content-length':payload.length}:{})}},res=>{
   if(res.statusCode!==200||!String(res.headers['content-type']).startsWith('application/json')){res.destroy();done(Error('PROVIDER_STATUS'));return}
   let size=0;const chunks:Buffer[]=[]
   res.on('data',(b:Buffer)=>{size+=b.length;if(size>4_000_000){res.destroy();done(Error('PROVIDER_SIZE'))}else chunks.push(b)})
   res.on('end',()=>{try{done(null,JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{done(Error('PROVIDER_JSON'))}});res.on('error',()=>done(Error('PROVIDER_RESPONSE')))
  })
  const abort=()=>{req.destroy();done(Error('PROVIDER_ABORTED'))};const timer=setTimeout(abort,timeout)
  signal.addEventListener('abort',abort,{once:true});req.on('error',()=>done(Error('PROVIDER_IO')))
  if(signal.aborted){abort();return}req.end(payload)
 })
export function createR36EvidenceReader(config:R36ProviderEndpoint):R36WorkerPorts['readEvidence']{
 const evidence=endpoint(config)
 return (kind,digest,signal,subjectDigest,evidenceNotBefore)=>{if(evidenceNotBefore!==undefined&&(!Number.isSafeInteger(evidenceNotBefore)||evidenceNotBefore<1))return Promise.reject(Error('EVIDENCE_GENERATION'));if(!R36_WORKER_KINDS.includes(kind)||!/^[0-9a-f]{64}$/.test(digest)||!/^[0-9a-f]{64}$/.test(subjectDigest))return Promise.reject(Error('EVIDENCE_DIGEST'));return request(evidence,`/r36/v1/evidence/${kind}/${subjectDigest}/${digest}${evidenceNotBefore===undefined?'':'/'+evidenceNotBefore}`,'GET',undefined,signal)}
}
/** Only the existing issuer route is reachable. A receipt response never grants
 * wallet activation, rotation, or a financial submission to this caller. */
export function createR36IssuerClient(config:R36ProviderEndpoint){
 const issuer=endpoint(config)
 return async(nonce:string,signal:AbortSignal):Promise<R36CertificateResult>=>{
  if(!/^[0-9a-f]{64}$/.test(nonce))throw Error('ISSUER_NONCE')
  const raw=await request(issuer,'/r36/v1/issue','POST',{nonce},signal,70000)
  const r=raw as R36CertificateResult|undefined
  if(!r||typeof r!=='object'||Array.isArray(r)||!['RECORDED','REPLAYED'].includes(r.outcome)||
   typeof r.reason!=='string'||typeof r.certificateDigest!=='string'||!/^[0-9a-f]{64}$/.test(r.certificateDigest)||
   r.authorizesFinancialRelease!==false||r.authorizesWalletActivation!==false||r.authorizesRotation!==false)
    throw Error('ISSUER_RESPONSE_INVALID')
  // Discard arbitrary server fields; the registrar cannot forward an authority flag.
  return {outcome:r.outcome,reason:r.reason,certificateDigest:r.certificateDigest,
   authorizesFinancialRelease:false,authorizesWalletActivation:false,authorizesRotation:false}
 }
}
/** Observe the policy already fixed in the private issuer configuration. This
 * does not enroll policy, approve a key, or assert independent network finality. */
export function createR36RegistryObserver(config:R36ProviderEndpoint,policyDigest:string){
 const issuer=endpoint(config)
 if(!/^[0-9a-f]{64}$/.test(policyDigest))throw Error('REGISTRY_POLICY')
 return async(signal:AbortSignal):Promise<void>=>{
  const r=await request(issuer,'/r36/v1/observe-owner-registry','POST',{},signal) as Record<string,unknown>|null
  if(!r||r.schema!=='R36_OWNER_REGISTRY_OBSERVATION_V1'||r.policyDigest!==policyDigest||r.financialAuthority!==false||r.networkFinality!==false||
    !Number.isSafeInteger(r.observedAt)||!Number.isSafeInteger(r.validUntil)||Number(r.observedAt)>Math.floor(Date.now()/1000)||
    Number(r.validUntil)<=Math.floor(Date.now()/1000)||Number(r.validUntil)>Number(r.observedAt)+120)throw Error('REGISTRY_OBSERVATION_INVALID')
 }
}
/** Fixed private lifecycle endpoint; the issuer determines policy and SQL. */
export function createR36LifecycleClient(config:R36ProviderEndpoint){
 const issuer=endpoint(config)
 return async(body:Record<string,unknown>,signal:AbortSignal):Promise<Record<string,unknown>>=>{
  const r=await request(issuer,'/r36/v1/lifecycle','POST',body,signal,70000) as Record<string,unknown>|null
  if(!r||r.schema!=='R36_LIFECYCLE_RESPONSE_V1'||!['CONTEXT','RECORDED','REPLAYED','BLOCKED'].includes(String(r.outcome))||r.financialAuthority!==false||r.financialSubmission!==false)throw Error('LIFECYCLE_RESPONSE_INVALID')
  return r
 }
}
/** Exact internal registrar route; never a public financial endpoint. */
export function createR36RegistrarClient(config:R36ProviderEndpoint){
 const registrar=endpoint(config)
 return async(binding:Record<string,unknown>,signal:AbortSignal):Promise<R36CertificateResult>=>{
  if(!binding||typeof binding.nonce!=='string'||!/^[0-9a-f]{64}$/.test(binding.nonce))throw Error('REGISTRAR_NONCE')
  const r=await request(registrar,'/r36/v1/register','POST',{binding},signal,135000) as R36CertificateResult|undefined
  if(!r||!['RECORDED','REPLAYED'].includes(r.outcome)||typeof r.reason!=='string'||typeof r.certificateDigest!=='string'||!/^[0-9a-f]{64}$/.test(r.certificateDigest)||r.authorizesFinancialRelease!==false||r.authorizesWalletActivation!==false||r.authorizesRotation!==false)throw Error('REGISTRAR_RESPONSE_INVALID')
  return {outcome:r.outcome,reason:r.reason,certificateDigest:r.certificateDigest,authorizesFinancialRelease:false,authorizesWalletActivation:false,authorizesRotation:false}
 }
}
export function createR36HttpsPorts(config:{evidence:R36ProviderEndpoint;signer:R36ProviderEndpoint}):R36WorkerPorts{
 const readEvidence=createR36EvidenceReader(config.evidence),signer=endpoint(config.signer)
 return Object.freeze({readEvidence,signOnce:async(q,signal)=>{
  const r=await request(signer,'/r36/v1/sign','POST',q,signal)
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='idempotencyKey,keyId,payloadDigest,signature')throw Error('SIGNER_RESPONSE_SHAPE')
  return r as Awaited<ReturnType<R36WorkerPorts['signOnce']>>
 }})
}
