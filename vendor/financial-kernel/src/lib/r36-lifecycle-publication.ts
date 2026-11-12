import {financialNetwork} from './financial-network'
/** Private durable lifecycle observations. New observations may renew PRIOR
 * evidence; an exact successor nonce is frozen once. Never signs a transaction. */
import {createHash,createPrivateKey,createPublicKey,sign,verify,randomUUID} from 'node:crypto'
import {lstat,realpath,open,link,unlink,readFile} from 'node:fs/promises'
import path from 'node:path'
import {assertR36PublicationPolicyCurrent as current,r36PublicationRoot as rootFor,r36PublicationPolicyIdentity as identity,r36ArtifactSignatureBytes as bytes,type R36PublicationPolicy} from './r36-evidence-publication'
type Row=Record<string,unknown>
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex'),hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)
const obj=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v),must=(v:unknown,s:string)=>{if(!v)throw Error(s)}
const kinds=['wallet_history','accounting','exceptions','exception_isolation','clearance'] as const
type Kind=typeof kinds[number]
function policy(c:Row):R36PublicationPolicy{
 const p=c.policy as Row;must(obj(p),'LIFECYCLE_POLICY_CONTEXT')
 return {policyDigest:String(p.policy_digest),approvalRecordDigest:String(p.approval_record_digest),enabled:p.enabled===true,revoked:p.revoked===true,validFrom:Number(p.valid_from),validUntil:Number(p.valid_until),maxAgeSeconds:Number(p.max_age_seconds),revocationCheckedAt:Number(p.revocation_checked_at),revocationValidUntil:Number(p.revocation_valid_until),workerProfile:p.worker_profile as R36PublicationPolicy['workerProfile']}
}
export async function publishR36LifecycleJob(input:{kind:'prior'|'bound';context:Row;cutoffLedger:string;artifacts:Record<string,Row>;privateKeyPem:string;jobDirectory:string;request:Row},ports:{refresh():Promise<Row>;submit(body:Row):Promise<Row>;now?:()=>number}):Promise<Row>{
 try{
  const q={...input,context:JSON.parse(JSON.stringify(input.context)),artifacts:JSON.parse(JSON.stringify(input.artifacts)) as Record<string,Row>,request:JSON.parse(JSON.stringify(input.request)) as Row},now=ports.now??(()=>Math.floor(Date.now()/1000)),subject=q.kind==='prior'?q.context.contextDigest:q.context.bindingDigest,pr=policy(q.context),scope=identity(pr),ks:Kind[]=q.kind==='prior'?[...kinds]:['clearance']
  must(hex(subject)&&/^[1-9][0-9]*$/.test(q.cutoffLedger)&&Object.keys(q.artifacts).sort().join()===ks.slice().sort().join(),'LIFECYCLE_PUBLICATION_INPUT');current(pr,now())
  const rawDigest=sha(JSON.stringify(q.artifacts)),base=await realpath(q.jobDirectory),st=await lstat(q.jobDirectory)
  must(st.isDirectory()&&!st.isSymbolicLink()&&(st.mode&0o077)===0,'LIFECYCLE_STORAGE_PRIVATE')
  // A fresh read-only prior observation may renew its short evidence window.
  // It is a different attestation, never a new payment/signing nonce or resend.
  const job=q.kind==='prior'?sha(subject+'\n'+rawDigest+'\n'+JSON.stringify(q.request)+'\n'+Math.floor(now()/30)):q.context.boundRenewal===true?sha(String(q.context.successorNonce)+'\n'+String(q.context.closureDigest)):String(q.context.successorNonce)
  must(hex(job),'LIFECYCLE_JOB_IDENTITY')
  const file=path.join(base,'lifecycle-'+q.kind+'-'+job+'.json')
  async function read():Promise<Row|null>{try{const s=await lstat(file);must(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o077)===0&&s.size<=12_100_000,'LIFECYCLE_FILE');return JSON.parse(await readFile(file,'utf8'))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}}
  async function fresh(){const c=await ports.refresh(),p=policy(c);must((q.kind==='prior'?c.contextDigest:c.bindingDigest)===subject&&identity(p)===scope,'LIFECYCLE_POLICY_CHANGED');current(p,now());return p}
  let stored=await read(),p=pr
  if(!stored){
   const at=now();p=await fresh();const key=createPrivateKey(q.privateKeyPem),pin=sha(createPublicKey(key).export({type:'spki',format:'der'})),bundle:Row={}
   must(key.asymmetricKeyType==='ed25519'&&obj(q.context.prior),'LIFECYCLE_SIGNING_KEY')
   for(const k of ks){const root=rootFor(p,k,now());must(root.publicKeySpkiSha256===pin&&p.revocationCheckedAt>=at&&root.revocationCheckedAt>=at,'LIFECYCLE_CUSTODIAN_OR_FRESHNESS')
    const text=JSON.stringify(q.artifacts[k]);must(Buffer.byteLength(text)<=2_000_000,'LIFECYCLE_ARTIFACT_SIZE')
    const manifest={schema:'R36_INDEPENDENT_ARTIFACT_V1',kind:k,policyDigest:p.policyDigest,subjectDigest:subject,artifactDigest:sha(text),issuerId:root.issuerId,keyId:root.keyId,network:financialNetwork(),sourceWallet:String(q.context.prior.source_wallet),cutoffLedger:q.cutoffLedger,issuedAt:String(at),expiresAt:String(Math.min(p.validUntil,root.validUntil))}
    bundle[k]={text,manifest,signature:sign(null,bytes(manifest),key).toString('base64')}
   }
   const body={schema:'R36_LIFECYCLE_PUBLICATION_V1',subjectDigest:subject,rawDigest,policyIdentity:scope,request:q.request,bundle},raw=JSON.stringify(body)
   must(Buffer.byteLength(raw)<=12_100_000,'LIFECYCLE_BUNDLE_SIZE')
   const tmp=file+'.'+randomUUID()+'.tmp',h=await open(tmp,'wx',0o600)
   try{await h.writeFile(raw);await h.sync();await h.close();try{await link(tmp,file)}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}const d=await open(base,'r');try{await d.sync()}finally{await d.close()}}finally{await h.close().catch(()=>{});await unlink(tmp).catch(()=>{})}
   stored=await read()
  }
  p=await fresh();must(stored?.schema==='R36_LIFECYCLE_PUBLICATION_V1'&&stored.subjectDigest===subject&&stored.rawDigest===rawDigest&&stored.policyIdentity===scope&&JSON.stringify(stored.request)===JSON.stringify(q.request)&&obj(stored.bundle),'LIFECYCLE_IMMUTABLE_JOB_CONFLICT')
  const bundle=stored!.bundle as Row
  must(Object.keys(bundle).sort().join()===ks.slice().sort().join(),'LIFECYCLE_BUNDLE_KINDS')
  for(const k of ks){const root=rootFor(p,k,now()),e=bundle[k] as Row,m=e?.manifest as Record<string,string>,sig=typeof e?.signature==='string'?Buffer.from(e.signature,'base64'):Buffer.alloc(0)
   must(obj(e)&&obj(m)&&m.policyDigest===p.policyDigest&&m.subjectDigest===subject&&m.kind===k&&m.issuerId===root.issuerId&&m.keyId===root.keyId&&m.sourceWallet===(q.context.prior as Row).source_wallet&&m.network===financialNetwork()&&m.cutoffLedger===q.cutoffLedger&&e.text===JSON.stringify(q.artifacts[k])&&m.artifactDigest===sha(String(e.text))&&Number(m.issuedAt)<=Math.min(now(),p.revocationCheckedAt,root.revocationCheckedAt)&&Number(m.expiresAt)>now()&&sig.length===64&&sig.toString('base64')===e.signature&&verify(null,bytes(m),root.publicKeyPem,sig),'LIFECYCLE_STORED_SIGNATURE_INVALID')
  }
  const out=await ports.submit({...q.request,subjectDigest:subject,bundle})
  must(['RECORDED','REPLAYED'].includes(String(out.outcome))&&hex(out.proofDigest)&&out.financialAuthority===false&&out.financialSubmission===false,'LIFECYCLE_ISSUER_NOT_CONFIRMED_RETRY_SAME_JOB')
  return {...out,evidenceIssuedAt:Math.max(...ks.map(k=>Number(((bundle[k] as Row).manifest as Row).issuedAt)))}
 }catch(e){return{outcome:'BLOCKED',reason:e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'LIFECYCLE_PUBLICATION_FAILED',financialAuthority:false,financialSubmission:false}}
}
