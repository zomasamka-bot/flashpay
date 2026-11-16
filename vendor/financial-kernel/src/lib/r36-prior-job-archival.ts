/** Bounded housekeeping of redundant PRIOR jobs. The independently controlled
 * issuer must first confirm exact durable originals; never grants a send right. */
import {opendir,lstat,realpath,open,rename,unlink} from 'node:fs/promises'
import {constants} from 'node:fs'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {readR36LifecycleBytes,releaseR36ArchivedPrior} from './r36-lifecycle-storage'
type Row=Record<string,unknown>
const obj=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const sha=(v:string)=>createHash('sha256').update(v).digest('hex')
export async function archiveR36PriorJobs(directory:string,policyDigest:string,archive:(body:Row)=>Promise<Row>){
 const result={checked:0,released:0,retained:0}
 const base=await realpath(directory),stat=await lstat(directory)
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||!/^[a-f0-9]{64}$/.test(policyDigest))throw Error('ARCHIVE_PRIVATE_SCOPE')
 const names=new Set<string>(),started=Date.now()
 const directories=[base]
 try{const d=await lstat(path.join(base,'prior'));if(!d.isDirectory()||d.isSymbolicLink()||(d.mode&0o077)!==0)throw Error('ARCHIVE_PRIVATE_SCOPE');directories.unshift(path.join(base,'prior'))}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
 // Short-lived hosts must not restart at the same four unconfirmed legacy
 // files forever. Persist only a lexical scheduling cursor, never permission
 // to delete. A crash may postpone a file to the next wrap, never lose it.
 const cursorFile=path.join(base,'.prior-archive-cursor.json');let after=''
 let handle
 try{handle=await open(cursorFile,constants.O_RDONLY|constants.O_NOFOLLOW);const s=await handle.stat();if(!s.isFile()||(s.mode&0o077)!==0||s.size>1024)throw Error('ARCHIVE_CURSOR_INVALID');const c=JSON.parse(await handle.readFile('utf8'));if(c.policy!==policyDigest||typeof c.after!=='string'||!/^(prior\/)?lifecycle-prior-[a-f0-9]{64}\.json$/.test(c.after))throw Error('ARCHIVE_CURSOR_INVALID');after=c.after}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}finally{await handle?.close()}
 const first:string[]=[],next:string[]=[];let scanned=0
 const keep=(a:string[],v:string)=>{if(!a.includes(v)){a.push(v);a.sort();if(a.length>4)a.pop()}}
 for(const directory of directories){
  const cursor=await opendir(directory)
  for await(const entry of cursor){
   if(++scanned>100000||Date.now()-started>2000)throw Error('ARCHIVE_DIRECTORY_BOUND')
   if(!/^lifecycle-prior-[a-f0-9]{64}\.json(?:\.gz)?$/.test(entry.name))continue
   const relative=path.relative(base,path.join(directory,entry.name.replace(/\.gz$/,'')))
   keep(first,relative);if(relative>after)keep(next,relative)
  }
 }
 const selected=next.length?next:first
 if(selected.length){
  const temp=cursorFile+'.'+randomUUID()+'.tmp',h=await open(temp,'wx',0o600)
  try{await h.writeFile(JSON.stringify({policy:policyDigest,after:selected[selected.length-1]}));await h.sync();await h.close();await rename(temp,cursorFile);const dir=await open(base,'r');try{await dir.sync()}finally{await dir.close()}}finally{await h.close().catch(()=>{});await unlink(temp).catch(()=>{})}
  for(const n of selected)names.add(path.join(base,n))
 }
 for(const name of names){
  if(Date.now()-started>20000)break
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
