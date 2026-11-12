import {financialNetwork} from './financial-network'
/** Private collector -> immutable signed artifacts -> registrar handoff.
 * Technical publication is not a policy enrollment or independent certification.
 * Only the existing registrar/issuer may accept it under their live DB policy.
 * Files contain a spendable XDR and belong on the private no-financial-egress volume.
 */
import {createHash,createPrivateKey,createPublicKey,sign,verify,randomUUID} from 'node:crypto'
import {open,link,unlink,lstat,readFile,realpath} from 'node:fs/promises'
import path from 'node:path'
import {R36_ADMISSION_FIELDS,type R36CertificateResult} from './r36-certificate-consumer'
import {R36_WORKER_KINDS} from './r36-certificate-worker'
import {reviewR36EvidenceSnapshot,r36SnapshotDigest} from './r36-evidence-snapshot'
import {publishR36Artifact} from './r36-operator-service'
import type {R36ProducedEvidence} from './r36-live-evidence-producer'
type Row=Record<string,unknown>
type Kind=typeof R36_WORKER_KINDS[number]
type Root={kind:Kind;issuerId:string;keyId:string;operatorId:string;publicKeyPem:string;publicKeySpkiSha256:string;validFrom:number;validUntil:number;revocationCheckedAt:number;revocationValidUntil:number;revoked:boolean}
export type R36PublicationPolicy={policyDigest:string;approvalRecordDigest:string;enabled:boolean;revoked:boolean;validFrom:number;validUntil:number;maxAgeSeconds:number;revocationCheckedAt:number;revocationValidUntil:number;workerProfile:{approvalDigest:string;runtimeOperatorId:string;migrationOperatorId:string;issuerOperatorId:string;authorities:Root[]}}
type Envelope={text:string;manifest:Record<string,string>;signature:string}
type Bundle={renewalGeneration?:number;schema:'R36_IMMUTABLE_PUBLICATION_V1';candidateDigest:string;policyDigest:string;policySnapshotDigest:string;sourceRowsDigest:string;binding:Row;artifacts:Record<Kind,Envelope>}
const fields=['schema','kind','policyDigest','subjectDigest','artifactDigest','issuerId','keyId','network','sourceWallet','cutoffLedger','issuedAt','expiresAt']
const digests:Record<Kind,string>={intent:'immutableIntentDigest',inbound_finality:'inboundFinalityDigest',wallet_history:'walletHistoryDigest',accounting:'accountingDigest',exceptions:'exceptionsDigest',exception_isolation:'exceptionIsolationDigest',clearance:'clearanceDigest'}
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex'),hex=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s)
const must=(v:unknown,s:string)=>{if(!v)throw Error(s)},clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v))
const bytes=(m:Record<string,string>)=>Buffer.from('FLASHpay:R36:INDEPENDENT_ARTIFACT:V1\n'+JSON.stringify(fields.map(k=>m[k])))
const denied=(reason:string):R36CertificateResult=>({outcome:'BLOCKED',reason,authorizesFinancialRelease:false,authorizesWalletActivation:false,authorizesRotation:false})
function policyIdentity(p:R36PublicationPolicy){
 // Fresh revocation observations may advance without changing the approved key,
 // scope or policy. Their current deadlines are checked on every attempt below.
 const c=clone(p);delete (c as Partial<R36PublicationPolicy>).revocationCheckedAt;delete (c as Partial<R36PublicationPolicy>).revocationValidUntil
 for(const r of c.workerProfile.authorities){delete (r as Partial<Root>).revocationCheckedAt;delete (r as Partial<Root>).revocationValidUntil}
 return r36SnapshotDigest(c)
}
export function r36PublicationNonce(candidateDigest:string,policyDigest:string){must(hex(candidateDigest)&&hex(policyDigest),'PUBLICATION_IDENTITY');return sha('FLASHpay:R36:PREPARED_PUBLICATION:V1\n'+candidateDigest+'\n'+policyDigest)}
function current(p:R36PublicationPolicy,now:number){
 const w=p.workerProfile;must(hex(p.policyDigest)&&hex(p.approvalRecordDigest)&&p.enabled===true&&p.revoked===false&&w?.approvalDigest===p.approvalRecordDigest,'PUBLICATION_POLICY_NOT_APPROVED')
 must([p.validFrom,p.validUntil,p.maxAgeSeconds,p.revocationCheckedAt,p.revocationValidUntil,now].every(Number.isSafeInteger)&&p.maxAgeSeconds>0&&p.maxAgeSeconds<=3600&&p.validFrom<=now&&now<p.validUntil&&p.revocationCheckedAt<=now&&now<p.revocationValidUntil,'PUBLICATION_POLICY_NOT_CURRENT')
 must([w.runtimeOperatorId,w.migrationOperatorId,w.issuerOperatorId].every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x))&&new Set([w.runtimeOperatorId,w.migrationOperatorId,w.issuerOperatorId]).size===3,'PUBLICATION_OPERATOR_SEPARATION')
}
function rootFor(p:R36PublicationPolicy,kind:Kind,now:number){
 const roots=p.workerProfile.authorities.filter(r=>r.kind===kind);must(roots.length===1,'PUBLICATION_ROOT_CARDINALITY');const r=roots[0]
 must(r.revoked===false&&[r.validFrom,r.validUntil,r.revocationCheckedAt,r.revocationValidUntil].every(Number.isSafeInteger)&&r.validFrom<=now&&now<r.validUntil&&r.revocationCheckedAt<=now&&now<r.revocationValidUntil&&
  /^[A-Za-z0-9_.:-]{1,128}$/.test(r.issuerId)&&/^[A-Za-z0-9_.:-]{1,128}$/.test(r.keyId)&&/^[A-Za-z0-9_.:-]{1,128}$/.test(r.operatorId)&&![p.workerProfile.runtimeOperatorId,p.workerProfile.migrationOperatorId].includes(r.operatorId),'PUBLICATION_ROOT_NOT_CURRENT_OR_SEPARATE')
 const key=createPublicKey(r.publicKeyPem);must(key.asymmetricKeyType==='ed25519'&&sha(key.export({type:'spki',format:'der'}))===r.publicKeySpkiSha256,'PUBLICATION_ROOT_PIN');return r
}
// Shared signature contract for admission and terminal observations. These
// helpers validate existing policy only; neither enrolls nor refreshes it.
export {current as assertR36PublicationPolicyCurrent,rootFor as r36PublicationRoot,policyIdentity as r36PublicationPolicyIdentity,bytes as r36ArtifactSignatureBytes}
async function privateDirectory(dir:string){const base=await realpath(dir),s=await lstat(dir);must(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o077)===0,'PUBLICATION_DIRECTORY_NOT_PRIVATE');return base}
async function readBundle(file:string):Promise<Bundle|null>{
 let s;try{s=await lstat(file)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}
 must(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o077)===0&&s.size<=29_000_000,'PUBLICATION_FILE_UNSAFE')
 return JSON.parse(await readFile(file,'utf8')) as Bundle
}
async function storeBundle(file:string,b:Bundle):Promise<Bundle>{
 const tmp=file+'.'+randomUUID()+'.tmp',f=await open(tmp,'wx',0o600)
 try{await f.writeFile(JSON.stringify(b));await f.sync();await f.close();try{await link(tmp,file)}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}
  const d=await open(path.dirname(file),'r');try{await d.sync()}finally{await d.close()}
 }finally{await f.close().catch(()=>{});await unlink(tmp).catch(()=>{})}
 const saved=await readBundle(file);must(saved,'PUBLICATION_COMMIT_MISSING');return saved!
}
function validate(b:Bundle,candidate:string,p:R36PublicationPolicy,sourceRowsDigest:string,now:number){
 current(p,now);must(b.schema==='R36_IMMUTABLE_PUBLICATION_V1'&&b.candidateDigest===candidate&&b.policyDigest===p.policyDigest&&b.policySnapshotDigest===policyIdentity(p)&&b.sourceRowsDigest===sourceRowsDigest,'PUBLICATION_FROZEN_SOURCE_CONFLICT')
 must(Object.keys(b.binding).length===R36_ADMISSION_FIELDS.length&&R36_ADMISSION_FIELDS.every(k=>typeof b.binding[k]==='string')&&b.binding.nonce===r36PublicationNonce(candidate,p.policyDigest)&&b.binding.network===financialNetwork(),'PUBLICATION_BINDING')
 const subject=sha(JSON.stringify(R36_ADMISSION_FIELDS.map(k=>b.binding[k]))),bodies:Record<string,Row>={}
 for(const kind of R36_WORKER_KINDS){const e=b.artifacts[kind],r=rootFor(p,kind,now),m=e?.manifest;must(m&&Object.keys(m).length===fields.length&&fields.every(k=>typeof m[k]==='string')&&m.schema==='R36_INDEPENDENT_ARTIFACT_V1'&&m.kind===kind&&m.policyDigest===p.policyDigest&&m.subjectDigest===subject&&m.issuerId===r.issuerId&&m.keyId===r.keyId&&m.network===b.binding.network&&m.sourceWallet===b.binding.sourceWallet&&m.cutoffLedger===b.binding.cutoffLedger,'PUBLICATION_MANIFEST')
  const start=Number(m.issuedAt),end=Number(m.expiresAt);must([start,end].every(Number.isSafeInteger)&&start>=Math.max(p.validFrom,r.validFrom)&&start<=now&&end>now&&end<=Math.min(p.validUntil,r.validUntil)&&start<=Math.min(p.revocationCheckedAt,r.revocationCheckedAt),'PUBLICATION_ARTIFACT_EXPIRED')
  must(typeof e.text==='string'&&Buffer.byteLength(e.text)<=2_000_000&&sha(e.text)===b.binding[digests[kind]]&&m.artifactDigest===sha(e.text),'PUBLICATION_BODY_DIGEST')
  const sig=Buffer.from(e.signature,'base64');must(sig.length===64&&sig.toString('base64')===e.signature&&verify(null,bytes(m),r.publicKeyPem,sig),'PUBLICATION_SIGNATURE')
  bodies[kind]=JSON.parse(e.text)
 }
 must(reviewR36EvidenceSnapshot(b.binding,bodies).outcome==='VERIFIED_SNAPSHOT','PUBLICATION_FINANCIAL_EVIDENCE_INVALID')
}
/** Persist the entire reviewed bundle before publishing the first artifact.
 * The existing registrar owns DB registration/sign-once; it rechecks live policy.
 * A timeout or restart reuses the exact nonce and bytes, never creates a replacement.
 */
export async function publishR36LiveEvidenceJob(input:{candidateDigest:string;sourceRowsDigest:string;policy:R36PublicationPolicy;custodianPrivateKeyPem:string;jobDirectory:string;artifactDirectory:string;renewal?:{generation:number;evidenceNotBefore:number}},
 ports:{collect(nonce:string):Promise<R36ProducedEvidence>;register(binding:Row):Promise<R36CertificateResult>;refreshPolicy?(signal:AbortSignal):Promise<R36PublicationPolicy>;now?:()=>number}):Promise<R36CertificateResult>{
 try{
  const c={...input,policy:clone(input.policy)},now=ports.now??(()=>Math.floor(Date.now()/1000));must(hex(c.candidateDigest)&&hex(c.sourceRowsDigest),'PUBLICATION_SOURCE_IDENTITY')
  const approvedIdentity=policyIdentity(c.policy)
  async function refresh(){
   if(!ports.refreshPolicy)return
   const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
   try{
    const fresh=clone(await Promise.race([ports.refreshPolicy(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('PUBLICATION_POLICY_REFRESH_DEADLINE'))},8000)})]))
    must(policyIdentity(fresh)===approvedIdentity,'PUBLICATION_POLICY_REFRESH_IDENTITY_CHANGED')
    current(fresh,now());c.policy=fresh
   }finally{if(timer)clearTimeout(timer)}
  }
  await refresh();current(c.policy,now())
  const base=await privateDirectory(c.jobDirectory),artifacts=await privateDirectory(c.artifactDirectory),nonce=r36PublicationNonce(c.candidateDigest,c.policy.policyDigest),file=path.join(base,nonce+(c.renewal?'.renewal-'+c.renewal.generation:'')+'.json')
  if(c.renewal)must(Number.isSafeInteger(c.renewal.generation)&&c.renewal.generation>0&&Number.isSafeInteger(c.renewal.evidenceNotBefore)&&c.renewal.evidenceNotBefore<=now(),'PUBLICATION_RENEWAL_CONTEXT')
  let b=await readBundle(file)
  if(!b){
   const produced=await ports.collect(nonce);must(produced.outcome==='UNSIGNED_CANDIDATE_REQUIRES_CUSTODIAN'&&produced.binding&&produced.artifacts&&produced.authorizesSubmission===false&&produced.independentCertification===false,'PUBLICATION_COLLECTOR_BLOCKED')
   const result=clone(produced),binding=result.binding!,raw=result.artifacts!,key=createPrivateKey(c.custodianPrivateKeyPem),pin=sha(createPublicKey(key).export({type:'spki',format:'der'}));must(key.asymmetricKeyType==='ed25519'&&binding.nonce===nonce,'PUBLICATION_CUSTODIAN_KEY')
   // Capture this operation's real issuance time, then read genuine later
   // revocation observations. Never replace it with an old observation's time.
   const at=now();await refresh();current(c.policy,now());must(reviewR36EvidenceSnapshot(binding,raw).outcome==='VERIFIED_SNAPSHOT','PUBLICATION_FINANCIAL_EVIDENCE_INVALID')
   b={...(c.renewal?{renewalGeneration:c.renewal.generation}:{}),schema:'R36_IMMUTABLE_PUBLICATION_V1',candidateDigest:c.candidateDigest,policyDigest:c.policy.policyDigest,policySnapshotDigest:policyIdentity(c.policy),sourceRowsDigest:c.sourceRowsDigest,binding,artifacts:{} as Record<Kind,Envelope>}
   const subject=sha(JSON.stringify(R36_ADMISSION_FIELDS.map(k=>binding[k])))
   for(const kind of R36_WORKER_KINDS){const root=rootFor(c.policy,kind,now());must(root.publicKeySpkiSha256===pin,'PUBLICATION_CUSTODIAN_NOT_APPROVED')
    // Never backdate a signature to make stale revocation observations pass.
    const issued=at;must(c.policy.revocationCheckedAt>=issued&&root.revocationCheckedAt>=issued,'PUBLICATION_FRESH_REVOCATION_OBSERVATION_REQUIRED')
    // Evidence must cover the certificate created later by the registrar. Its
    // expiry is bounded by the approved roots; the issuer bounds certificate age.
    const expires=Math.min(c.policy.validUntil,root.validUntil),text=JSON.stringify(raw[kind]);
    const manifest={schema:'R36_INDEPENDENT_ARTIFACT_V1',kind,policyDigest:c.policy.policyDigest,subjectDigest:subject,artifactDigest:sha(text),issuerId:root.issuerId,keyId:root.keyId,network:String(binding.network),sourceWallet:String(binding.sourceWallet),cutoffLedger:String(binding.cutoffLedger),issuedAt:String(issued),expiresAt:String(expires)}
    b.artifacts[kind]={text,manifest,signature:sign(null,bytes(manifest),key).toString('base64')}
   }
   validate(b,c.candidateDigest,c.policy,c.sourceRowsDigest,now());b=await storeBundle(file,b)
  }
  if(c.renewal){
   must(b.renewalGeneration===c.renewal.generation,'PUBLICATION_RENEWAL_GENERATION')
   for(const kind of R36_WORKER_KINDS)must(Number(b.artifacts[kind].manifest.issuedAt)>=c.renewal.evidenceNotBefore,'PUBLICATION_RENEWAL_EVIDENCE_STALE')
  }
  validate(b,c.candidateDigest,c.policy,c.sourceRowsDigest,now())
  for(const kind of R36_WORKER_KINDS){const e=b.artifacts[kind];await publishR36Artifact(artifacts,kind,e.manifest.artifactDigest,e,c.renewal?.evidenceNotBefore)}
  await refresh()
  validate(b,c.candidateDigest,c.policy,c.sourceRowsDigest,now())
  const r=await ports.register(clone(b.binding));must(['RECORDED','REPLAYED'].includes(r.outcome)&&hex(r.certificateDigest)&&r.authorizesFinancialRelease===false&&r.authorizesRotation===false&&r.authorizesWalletActivation===false,'PUBLICATION_REGISTRAR_NOT_CONFIRMED_RETRY_SAME_BUNDLE')
  return {outcome:r.outcome,reason:'PUBLISHED_AND_REGISTERED_SUBJECT_TO_ORIGINAL_FINANCIAL_GUARDS',certificateDigest:r.certificateDigest,authorizesFinancialRelease:false,authorizesRotation:false,authorizesWalletActivation:false}
 }catch(e){return denied(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'PUBLICATION_FAILED_CLOSED_RETRY_SAME_BUNDLE')}
}
