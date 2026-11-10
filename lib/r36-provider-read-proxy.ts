/** Separate provider process: the private producer has no Internet route.
 * This small mTLS bridge can send only bounded GETs to fixed Pi Testnet sources.
 * The Pi key stays here; callers cannot supply headers, URLs, methods or redirects.
 */
import https from 'node:https'
import {checkServerIdentity,type TLSSocket} from 'node:tls'
import {createHash,X509Certificate} from 'node:crypto'
import type {R36ServiceConfig} from './r36-operator-service'
import type {R36ProviderEndpoint} from './r36-provider-transport'
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
export function r36ReadTarget(input:unknown):{url:string;pi:boolean}{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='path,provider')throw Error('READ_PROXY_FIELDS')
 const q=input as {path:unknown;provider:unknown}
 if(typeof q.path!=='string'||q.path.length>512||!q.path.startsWith('/')||/[\s%\\#]/.test(q.path)||q.path.includes('..'))throw Error('READ_PROXY_PATH')
 const origin=q.provider==='pi'?'https://api.minepi.com':q.provider==='horizon'?'https://api.testnet.minepi.com':null
 if(!origin)throw Error('READ_PROXY_PROVIDER');const u=new URL(q.path,origin);if(u.origin!==origin)throw Error('READ_PROXY_ORIGIN')
 if(q.provider==='pi'){
  if(u.search||!/^\/v2\/payments\/[A-Za-z0-9_-]{1,128}$/.test(u.pathname))throw Error('READ_PROXY_PI_ROUTE')
 }else{
  const account='G[A-Z2-7]{55}',hash='[0-9a-f]{64}'
  if(!new RegExp('^(?:/accounts/'+account+'(?:/transactions)?|/transactions/'+hash+'(?:/operations)?|/ledgers/[0-9]{1,12})$').test(u.pathname))throw Error('READ_PROXY_HORIZON_ROUTE')
  if(u.search){if(!u.pathname.endsWith('/transactions')&&!u.pathname.endsWith('/operations'))throw Error('READ_PROXY_QUERY');const keys=[...u.searchParams.keys()];if(new Set(keys).size!==keys.length||keys.some(k=>!['cursor','order','limit','include_failed'].includes(k)))throw Error('READ_PROXY_QUERY')
   if(u.searchParams.has('include_failed')&&u.searchParams.get('include_failed')!=='true')throw Error('READ_PROXY_FAILED_HISTORY_REQUIRED')
   if(u.searchParams.has('cursor')&&!/^[0-9]{1,40}$/.test(u.searchParams.get('cursor')!))throw Error('READ_PROXY_CURSOR')
   if(u.searchParams.has('order')&&u.searchParams.get('order')!=='asc')throw Error('READ_PROXY_ORDER')
   if(u.searchParams.has('limit')&&!/^(?:[1-9][0-9]?|1[0-9]{2}|200)$/.test(u.searchParams.get('limit')!))throw Error('READ_PROXY_LIMIT')
  }
 }
 return{url:u.href,pi:q.provider==='pi'}
}
export function createR36ReadProxy(c:R36ServiceConfig,piKey:string,fetcher:typeof fetch=fetch){
 if(!piKey||!c.clientPins.length)throw Error('READ_PROXY_CONFIG')
 const server=https.createServer({cert:c.serverCertPem,key:c.serverKeyPem,ca:c.clientCaPem,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},async(req,res)=>{
  const send=(status:number,b:unknown)=>{if(!res.writableEnded)res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(b))}
  try{
   const socket=req.socket as TLSSocket,peer=socket.getPeerCertificate();if(!socket.authorized||!peer.raw||!c.clientPins.includes(sha(new X509Certificate(peer.raw).publicKey.export({type:'spki',format:'der'})))){send(403,{error:'READ_PROXY_CLIENT'});return}
   if(req.method!=='POST'||req.url!=='/r36/v1/provider-read'||!String(req.headers['content-type']).startsWith('application/json')){send(404,{error:'READ_PROXY_ROUTE'});return}
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>1024)throw Error('READ_PROXY_SIZE')}
   const target=r36ReadTarget(JSON.parse(raw)),r=await fetcher(target.url,{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000),headers:target.pi?{Authorization:'Key '+piKey}:{accept:'application/json'}})
   if(r.redirected||!r.body||![200,404,429,500,502,503,504].includes(r.status))throw Error('READ_PROXY_STATUS')
   const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>2_000_000)throw Error('READ_PROXY_RESPONSE_SIZE');chunks.push(x.value)}}finally{await reader.cancel().catch(()=>{})}
   const text=Buffer.concat(chunks).toString('utf8');JSON.parse(text);send(200,{status:r.status,text})
  }catch{send(422,{error:'READ_PROXY_REJECTED'})}
 });server.requestTimeout=10000;server.headersTimeout=10000;server.setTimeout(12000,s=>s.destroy());return server
}
export function createR36ReadProxyFetch(c:R36ProviderEndpoint):typeof fetch{
 const origin=new URL(c.origin);if(origin.protocol!=='https:'||origin.hostname!=='r36-provider.internal'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash||!/^[0-9a-f]{64}$/.test(c.serverSpkiSha256))throw Error('READ_PROXY_FIXED_PRIVATE_ENDPOINT')
 const adapter=async(input:URL|string|Request,init?:RequestInit):Promise<Response>=>{
  if(input instanceof Request||init?.method&&init.method!=='GET')throw Error('READ_PROXY_GET_ONLY');const u=new URL(String(input));const provider=u.origin==='https://api.minepi.com'?'pi':u.origin==='https://api.testnet.minepi.com'?'horizon':null
  if(!provider||u.username||u.password||u.hash)throw Error('READ_PROXY_FIXED_PROVIDER');const payload={provider,path:u.pathname+u.search};r36ReadTarget(payload)
  return new Promise((resolve,reject)=>{const data=Buffer.from(JSON.stringify(payload));let finished=false;let timer:ReturnType<typeof setTimeout>
   const done=(error?:Error,value?:Response)=>{if(finished)return;finished=true;clearTimeout(timer);init?.signal?.removeEventListener('abort',abort);if(error)reject(Error('READ_PROXY_UNAVAILABLE'));else resolve(value!)}
   const request=https.request(new URL('/r36/v1/provider-read',origin),{method:'POST',agent:false,ca:c.caPem,cert:c.clientCertPem,key:c.clientKeyPem,rejectUnauthorized:true,minVersion:'TLSv1.3',checkServerIdentity:(h,p)=>checkServerIdentity(h,p)||(sha(new X509Certificate(p.raw).publicKey.export({type:'spki',format:'der'}))===c.serverSpkiSha256?undefined:Error('READ_PROXY_PIN')),headers:{'content-type':'application/json','content-length':data.length}},res=>{
    if(res.statusCode!==200){res.destroy();done(Error('READ_PROXY_STATUS'));return}let text='';res.on('data',b=>{text+=b;if(Buffer.byteLength(text)>4_000_000){res.destroy();done(Error('READ_PROXY_SIZE'))}});res.on('error',()=>done(Error('READ_PROXY_RESPONSE')));res.on('end',()=>{try{const v=JSON.parse(text);if(!v||Object.keys(v).sort().join(',')!=='status,text'||!Number.isInteger(v.status)||typeof v.text!=='string'||Buffer.byteLength(v.text)>2_000_000)throw Error('READ_PROXY_RESPONSE');done(undefined,new Response(v.text,{status:v.status,headers:{'content-type':'application/json'}}))}catch{done(Error('READ_PROXY_RESPONSE'))}})
   });const abort=()=>{request.destroy();done(Error('READ_PROXY_ABORT'))};timer=setTimeout(abort,10000);request.on('error',()=>done(Error('READ_PROXY_IO')));init?.signal?.addEventListener('abort',abort,{once:true});if(init?.signal?.aborted){abort();return}request.end(data)
  })
 };return adapter as typeof fetch
}
