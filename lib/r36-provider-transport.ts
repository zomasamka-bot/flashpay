/** Executable mTLS, pinned HTTPS ports. No arbitrary URL, redirect or finance endpoint.
 * Config is deployment/operator input, never an HTTP caller's input. No key fallback.
 */
import https from 'node:https'
import {checkServerIdentity} from 'node:tls'
import {X509Certificate,createHash} from 'node:crypto'
import {R36_WORKER_KINDS,type R36WorkerPorts} from './r36-certificate-worker'
export type R36ProviderEndpoint={origin:string;serverSpkiSha256:string;caPem:string;clientCertPem:string;clientKeyPem:string}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
function endpoint(c:R36ProviderEndpoint){
 const v={...c},u=new URL(v.origin)
 if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||/^(?:.*\.)?(?:minepi\.com|vercel\.app|neon\.tech|upstash\.io)$/i.test(u.hostname)||!/^[0-9a-f]{64}$/.test(v.serverSpkiSha256)||![v.caPem,v.clientCertPem,v.clientKeyPem].every(x=>typeof x==='string'&&x.length>0))throw Error('PROVIDER_ENDPOINT_NOT_ALLOWED')
 return{config:v,url:u}
}
export function createR36HttpsPorts(config:{evidence:R36ProviderEndpoint;signer:R36ProviderEndpoint}):R36WorkerPorts{
 const evidence=endpoint(config.evidence),signer=endpoint(config.signer)
 const request=(target:ReturnType<typeof endpoint>,path:string,method:'GET'|'POST',body:unknown,signal:AbortSignal):Promise<unknown>=>new Promise((resolve,reject)=>{
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
  const abort=()=>{req.destroy();done(Error('PROVIDER_ABORTED'))};const timer=setTimeout(abort,8000)
  signal.addEventListener('abort',abort,{once:true});req.on('error',()=>done(Error('PROVIDER_IO')))
  if(signal.aborted){abort();return}req.end(payload)
 })
 return Object.freeze({readEvidence:(kind,digest,signal,subjectDigest)=>{if(!R36_WORKER_KINDS.includes(kind)||!/^[0-9a-f]{64}$/.test(digest)||!/^[0-9a-f]{64}$/.test(subjectDigest))return Promise.reject(Error('EVIDENCE_DIGEST'));return request(evidence,`/r36/v1/evidence/${kind}/${subjectDigest}/${digest}`,'GET',undefined,signal)},signOnce:async(q,signal)=>{
  const r=await request(signer,'/r36/v1/sign','POST',q,signal)
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='idempotencyKey,keyId,payloadDigest,signature')throw Error('SIGNER_RESPONSE_SHAPE')
  return r as Awaited<ReturnType<R36WorkerPorts['signOnce']>>
 }})
}
