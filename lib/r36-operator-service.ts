/** NOT_FOR_DEPLOY. Separate operator process; not imported by any Next.js route.
 * mTLS client pins authorize evidence reads/signing requests. Signer SQL approval,
 * rather than possession of a client certificate alone, authorizes exact bytes.
 */
import https from 'node:https'
import {X509Certificate,createHash,createPrivateKey,randomUUID} from 'node:crypto'
import type {TLSSocket} from 'node:tls'
import {readFile,lstat,realpath,open,link,unlink} from 'node:fs/promises'
import path from 'node:path'
import type {R36CertificateDatabase,R36CertificateResult} from './r36-certificate-consumer'
import {signR36ApprovedOnce,type R36SignRequest} from './r36-durable-signer'
import {R36_WORKER_KINDS} from './r36-certificate-worker'
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex')
export async function publishR36Artifact(directory:string,kind:string,digest:string,envelope:unknown):Promise<'RECORDED'|'REPLAYED'>{
 if(!R36_WORKER_KINDS.includes(kind as typeof R36_WORKER_KINDS[number])||!/^[0-9a-f]{64}$/.test(digest)||!envelope||typeof envelope!=='object')throw Error('ARTIFACT_INPUT')
 const e=envelope as Record<string,unknown>;if(Object.keys(e).sort().join(',')!=='manifest,signature,text'||typeof e.text!=='string'||Buffer.byteLength(e.text,'utf8')>2_000_000||sha(e.text)!==digest)throw Error('ARTIFACT_DIGEST')
 const manifest=e.manifest as Record<string,unknown>;if(!manifest||typeof manifest.subjectDigest!=='string'||!/^[0-9a-f]{64}$/.test(manifest.subjectDigest))throw Error('ARTIFACT_SUBJECT')
 const base=await realpath(directory),file=path.join(base,kind+'-'+manifest.subjectDigest+'-'+digest+'.json'),bytes=JSON.stringify(envelope)
 if(Buffer.byteLength(bytes,'utf8')>4_000_000)throw Error('ARTIFACT_ENVELOPE_TOO_LARGE')
 // Sync complete bytes before publishing one immutable directory entry. A crash
 // leaves at most an unreferenced temp file; readers never see partial artifacts.
 const temporary=path.join(base,'.r36-publish-'+randomUUID()),handle=await open(temporary,'wx',0o600)
 try{
  await handle.writeFile(bytes);await handle.sync();await handle.close()
  try{await link(temporary,file);const directoryHandle=await open(base,'r');try{await directoryHandle.sync()}finally{await directoryHandle.close()}return'RECORDED'}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}
 }finally{await handle.close().catch(()=>{});await unlink(temporary).catch(()=>{})}
 const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||(await readFile(file,'utf8'))!==bytes)throw Error('ARTIFACT_IMMUTABLE_CONFLICT');const directoryHandle=await open(base,'r');try{await directoryHandle.sync()}finally{await directoryHandle.close()}return'REPLAYED'
}
export type R36ServiceConfig={host:string;port:number;serverCertPem:string;serverKeyPem:string;clientCaPem:string;clientPins:readonly string[]}
export function createR36OperatorService(config:R36ServiceConfig,mode:{kind:'evidence';directory:string}|{kind:'signer';db:R36CertificateDatabase;signingKeyPem:string}|{kind:'issuer';issue:(nonce:string)=>Promise<R36CertificateResult>}){
 const c={...config,clientPins:[...config.clientPins]};if(!Number.isInteger(c.port)||c.port<0||c.port>65535||!c.clientPins.length||!c.clientPins.every(v=>/^[0-9a-f]{64}$/.test(v)))throw Error('SERVICE_CONFIG')
 const signingKey=mode.kind==='signer'?createPrivateKey(mode.signingKeyPem):undefined
 const server=https.createServer({cert:c.serverCertPem,key:c.serverKeyPem,ca:c.clientCaPem,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},async(req,res)=>{
  const reply=(status:number,value:unknown)=>{if(!res.writableEnded){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))}}
  try{
   const socket=req.socket as TLSSocket,peer=socket.getPeerCertificate();if(!socket.authorized||!peer.raw||!c.clientPins.includes(sha(new X509Certificate(peer.raw).publicKey.export({type:'spki',format:'der'})))){reply(403,{error:'CLIENT_NOT_APPROVED'});return}
   if(mode.kind==='evidence'){
    const match=/^\/r36\/v1\/evidence\/([a-z_]+)\/([0-9a-f]{64})\/([0-9a-f]{64})$/.exec(req.url??'')
    if(req.method!=='GET'||!match||!R36_WORKER_KINDS.includes(match[1] as typeof R36_WORKER_KINDS[number])){reply(404,{error:'ROUTE_NOT_ALLOWED'});return}
    const base=await realpath(mode.directory),file=path.join(base,match[1]+'-'+match[2]+'-'+match[3]+'.json'),st=await lstat(file)
    if(!st.isFile()||st.isSymbolicLink()||st.size>4_000_000||await realpath(file)!==file)throw Error('ARTIFACT_FILE')
    const raw=await readFile(file,'utf8'),e=JSON.parse(raw)
    if(typeof e.text!=='string'||sha(e.text)!==match[3]||e.manifest?.subjectDigest!==match[2])throw Error('ARTIFACT_HASH');reply(200,e);return
   }
   const route=mode.kind==='issuer'?'/r36/v1/issue':'/r36/v1/sign'
   if(req.method!=='POST'||req.url!==route||!String(req.headers['content-type']).startsWith('application/json')){reply(404,{error:'ROUTE_NOT_ALLOWED'});return}
   const chunks:Buffer[]=[];let size=0
   for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>65536){reply(413,{error:'REQUEST_TOO_LARGE'});req.destroy();return}chunks.push(b)}
   const body:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'))
   if(mode.kind==='issuer'){
    // The transport only names an already protected request. It cannot enroll
    // policy, evidence, wallet authority, signing bytes or caller approvals.
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='nonce'||
       typeof (body as {nonce?:unknown}).nonce!=='string'||!/^[0-9a-f]{64}$/.test((body as {nonce:string}).nonce)){
     reply(422,{error:'ISSUER_REQUEST_INVALID'});return
    }
    const out=await mode.issue((body as {nonce:string}).nonce)
    reply(out.outcome==='RECORDED'||out.outcome==='REPLAYED'?200:422,out);return
   }
   const out=await signR36ApprovedOnce(mode.db,signingKey!,body as R36SignRequest);reply(200,out)
  }catch{reply(422,{error:'REQUEST_REJECTED'})}
 })
 server.requestTimeout=10000;server.headersTimeout=10000
 // Issuance checks seven bounded evidence artifacts and one bounded signing call.
 // The body deadline stays short; the response permits the original worker budget.
 server.setTimeout(mode.kind==='issuer'?70000:10000,s=>s.destroy())
 return server
}
