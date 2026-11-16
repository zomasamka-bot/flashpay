/** Closed, certified operations only. Archive exact original bytes before
 * releasing redundant private-volume copies. Lost acknowledgements retain data. */
import {open,lstat,realpath,unlink} from 'node:fs/promises'
import {constants} from 'node:fs'
import {gzipSync,gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import path from 'node:path'
type Row=Record<string,unknown>
const obj=(x:unknown):x is Row=>!!x&&typeof x==='object'&&!Array.isArray(x)
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const must=(x:unknown)=>{if(!x)throw Error('CLOSED_ARCHIVE_VERIFICATION')}
const key=/^([a-f0-9]{64}(\.renewal-[1-9][0-9]*)?|lifecycle-bound-[a-f0-9]{64})\.json$/
async function read(file:string,limit:number){let f;try{f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const s=await f.stat();must(s.isFile()&&(s.mode&0o077)===0&&s.size<=limit);return await f.readFile()}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}finally{await f?.close()}}
async function privateRoot(directory:string){const s=await lstat(directory);must(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o077)===0);return realpath(directory)}
async function sync(dir:string){const f=await open(dir,'r');try{await f.sync()}finally{await f.close()}}
export async function archiveR36ClosedEvidence(jobs:string,artifacts:string,policy:string,send:(body:Row)=>Promise<Row>){
 const base=await privateRoot(jobs),art=await privateRoot(artifacts),out={checked:0,released:0,retained:0};must(/^[a-f0-9]{64}$/.test(policy))
 async function call(operation:string,jobKey='',payload=''){
  const r=await send({action:'closed_archive',operation,jobKey,payload});must(r.outcome==='ARCHIVE_RESPONSE'&&r.financialAuthority===false&&r.financialSubmission===false);return r.archive
 }
 const pending=await call('pending');must(Array.isArray(pending)&&pending.length<=4)
 for(const q of pending as Row[]){
  out.checked++;const name=String(q.jobKey)
  try{
   must(key.test(name)&&['admission','bound'].includes(String(q.kind)))
   const file=path.join(base,name),plain=await read(file,29_000_000),packed=q.kind==='bound'?await read(file+'.gz',12_100_000):null
   const raw=packed?gunzipSync(packed,{maxOutputLength:12_100_000}):plain;if(plain&&packed)must(plain.equals(raw!))
   let ack=await call('lookup',name)
   if(raw){
    const value=JSON.parse(raw.toString('utf8'));must(obj(value))
    if(!ack)ack=await call('retain',name,gzipSync(raw,{level:6}).toString('base64'))
    must(obj(ack)&&ack.schema==='R36_CLOSED_ARCHIVE_ACK_V1'&&ack.policyDigest===policy&&ack.jobKey===name&&ack.rawDigest===sha(raw)&&ack.bytes===raw.length&&ack.scope==='HISTORICAL_RECORD_ONLY')
    if(q.kind==='admission'){
     must(obj(value.artifacts)&&Object.keys(value.artifacts).length===7)
     for(const [kind,envelope] of Object.entries(value.artifacts)){
      must(['intent','inbound_finality','wallet_history','accounting','exceptions','exception_isolation','clearance'].includes(kind)&&obj(envelope)&&obj(envelope.manifest))
      const e=envelope as Row,m=e.manifest as Row;must(/^[a-f0-9]{64}$/.test(String(m.subjectDigest))&&/^[a-f0-9]{64}$/.test(String(m.artifactDigest)))
      const floor=value.renewalGeneration===undefined?'':'.renewal-'+String(q.evidenceFloor)
      if(value.renewalGeneration!==undefined)must(/^[1-9][0-9]{0,15}$/.test(String(q.evidenceFloor)))
      const target=path.join(art,kind+'-'+m.subjectDigest+'-'+m.artifactDigest+floor+'.json'),bytes=await read(target,8_100_000)
      if(bytes){must(bytes.equals(Buffer.from(JSON.stringify(e))));await unlink(target)}
     }
     await sync(art)
    }
    // Recheck immutable job bytes after durable acknowledgement and artifact
    // release; neither an expired certificate nor a copied nonce authorizes this.
    for(const target of [file,...(q.kind==='bound'?[file+'.gz']:[])]){const bytes=await read(target,29_000_000);if(bytes){must((target.endsWith('.gz')?gunzipSync(bytes,{maxOutputLength:29_000_000}):bytes).equals(raw));await unlink(target)}}
    await sync(base)
   }else must(obj(ack)&&ack.schema==='R36_CLOSED_ARCHIVE_ACK_V1'&&ack.policyDigest===policy&&ack.jobKey===name&&typeof ack.rawDigest==='string')
   await call('released',name,String((ack as Row).rawDigest));out.released++
  }catch{out.retained++;try{await call('defer',name)}catch{/* No acknowledgement means all remaining originals stay. */}}
 }
 return out
}
