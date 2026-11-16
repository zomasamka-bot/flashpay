/** Bounded housekeeping of redundant PRIOR jobs. The independently controlled
 * issuer must first confirm exact durable originals; never grants a send right. */
import {opendir,lstat,realpath} from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {readR36LifecycleBytes,releaseR36ArchivedPrior} from './r36-lifecycle-storage'
type Row=Record<string,unknown>
const obj=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const cursors=new Map<string,Awaited<ReturnType<typeof opendir>>>()
const sha=(v:string)=>createHash('sha256').update(v).digest('hex')
export async function archiveR36PriorJobs(directory:string,policyDigest:string,archive:(body:Row)=>Promise<Row>){
 const result={checked:0,released:0,retained:0}
 const base=await realpath(directory),stat=await lstat(directory)
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||!/^[a-f0-9]{64}$/.test(policyDigest))throw Error('ARCHIVE_PRIVATE_SCOPE')
 const names=new Set<string>(),started=Date.now();let scanned=0
 const directories=[base]
 try{const d=await lstat(path.join(base,'prior'));if(!d.isDirectory()||d.isSymbolicLink()||(d.mode&0o077)!==0)throw Error('ARCHIVE_PRIVATE_SCOPE');directories.unshift(path.join(base,'prior'))}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
 for(const directory of directories){
  if(names.size>=4||Date.now()-started>2000)break
  let cursor=cursors.get(directory)
  if(!cursor){if(cursors.size>=8)throw Error('ARCHIVE_DIRECTORY_BOUND');cursor=await opendir(directory);cursors.set(directory,cursor)}
  while(scanned<1024&&names.size<4&&Date.now()-started<=2000){
   const entry=await cursor.read();if(!entry){await cursor.close();cursors.delete(directory);break}
   scanned++
   if(/^lifecycle-prior-[a-f0-9]{64}\.json(?:\.gz)?$/.test(entry.name))names.add(path.join(directory,entry.name.replace(/\.gz$/,'')))
  }
 }
 for(const name of names){
  if(Date.now()-started>2000)break
  result.checked++
  try{
   const file=name,raw=await readR36LifecycleBytes(file);if(!raw)continue
   const job=JSON.parse(raw.toString('utf8'))
   if(!obj(job)||job.schema!=='R36_LIFECYCLE_PUBLICATION_V1'||!obj(job.request)||job.request.action!=='record_prior'||!obj(job.bundle))throw Error('ARCHIVE_JOB')
   const out=await archive({action:'archive_prior',wallet:job.request.wallet,paymentId:job.request.paymentId,bundle:job.bundle})
   if(out.outcome!=='ARCHIVED'||out.financialAuthority!==false||out.financialSubmission!==false||!obj(out.archive)||
    out.archive.schema!=='R36_PRIOR_ARCHIVE_ACK_V1'||out.archive.policyDigest!==policyDigest||
    typeof out.archive.proofDigest!=='string'||!/^[a-f0-9]{64}$/.test(out.archive.proofDigest)||out.archive.bundleSha256!==sha(JSON.stringify(job.bundle)))throw Error('ARCHIVE_UNCONFIRMED')
   await releaseR36ArchivedPrior(file,raw);result.released++
  }catch{result.retained++}
 }
 return result
}
