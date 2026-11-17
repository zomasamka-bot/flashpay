/** Bounded housekeeping of redundant PRIOR jobs. The independently controlled
 * issuer must first confirm exact durable originals; never grants a send right. */
import {lstat,realpath} from 'node:fs/promises'
import {selectPriorWork,deferPriorWork,finishPriorWork} from './r36-prior-work-index'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {readR36LifecycleBytes,releaseR36ArchivedPrior} from './r36-lifecycle-storage'
type Row=Record<string,unknown>
const obj=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const sha=(v:string)=>createHash('sha256').update(v).digest('hex')
export async function archiveR36PriorJobs(directory:string,policyDigest:string,archive:(body:Row)=>Promise<Row>){
 const result={checked:0,released:0,retained:0}
 const base=await realpath(directory),stat=await lstat(directory)
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||!/^[a-f0-9]{64}$/.test(policyDigest))throw Error('ARCHIVE_PRIVATE_SCOPE')
 const started=Date.now(),selected=selectPriorWork(base)
 for(const work of selected){
  const name=path.join(base,work.name)
  if(Date.now()-started>20000)break
  result.checked++
  try{
   const file=name,raw=await readR36LifecycleBytes(file);if(!raw){if(work.phase==='ack'){finishPriorWork(base,work);result.released++}else{deferPriorWork(base,work);result.retained++}continue}
   const job=JSON.parse(raw.toString('utf8'))
   if(!obj(job)||job.schema!=='R36_LIFECYCLE_PUBLICATION_V1'||!obj(job.request)||job.request.action!=='record_prior'||!obj(job.bundle))throw Error('ARCHIVE_JOB')
   const out=await archive({action:'archive_prior',wallet:job.request.wallet,paymentId:job.request.paymentId,bundle:job.bundle})
   if(out.outcome!=='ARCHIVED'||out.financialAuthority!==false||out.financialSubmission!==false||!obj(out.archive)||
    out.archive.schema!=='R36_PRIOR_ARCHIVE_ACK_V1'||out.archive.policyDigest!==policyDigest||
    typeof out.archive.proofDigest!=='string'||!/^[a-f0-9]{64}$/.test(out.archive.proofDigest)||out.archive.bundleSha256!==sha(JSON.stringify(job.bundle)))throw Error('ARCHIVE_UNCONFIRMED')
   await releaseR36ArchivedPrior(file,raw);result.released++
  }catch{deferPriorWork(base,work);result.retained++}
 }
 return result
}
