/** Lossless private storage for immutable prior-closure bundles. Compression
 * changes no signed bytes, nonce, certificate, accounting fact or send right. */
import {constants} from 'node:fs'
import {open,lstat,realpath,readdir,link,unlink} from 'node:fs/promises'
import {gzipSync,gunzipSync} from 'node:zlib'
import {randomUUID,createHash} from 'node:crypto'
import path from 'node:path'
const LIMIT=12_100_000
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const must=(v:unknown)=>{if(!v)throw Error('LIFECYCLE_STORAGE_INVALID')}
async function readBytes(file:string):Promise<Buffer|null>{
 let handle
 try{
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
  const s=await handle.stat();must(s.isFile()&&(s.mode&0o077)===0&&s.size<=LIMIT)
  return await handle.readFile()
 }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}
 finally{await handle?.close()}
}
function unpack(b:Buffer){return gunzipSync(b,{maxOutputLength:LIMIT})}
async function syncDirectory(file:string){const d=await open(path.dirname(file),'r');try{await d.sync()}finally{await d.close()}}
export async function readR36LifecycleBytes(file:string):Promise<Buffer|null>{
 const [plain,packed]=await Promise.all([readBytes(file),readBytes(file+'.gz')])
 if(!packed)return plain
 const raw=unpack(packed);if(plain)must(plain.equals(raw));return raw
}
export async function storeR36LifecycleBytes(file:string,raw:Buffer):Promise<Buffer>{
 must(raw.length>0&&raw.length<=LIMIT)
 const existing=await readR36LifecycleBytes(file)
 if(existing){must(existing.equals(raw));return existing}
 const packed=gzipSync(raw,{level:6});must(packed.length<=LIMIT&&unpack(packed).equals(raw))
 const temp=file+'.'+randomUUID()+'.gz.tmp',h=await open(temp,'wx',0o600)
 try{
  await h.writeFile(packed);await h.sync();await h.close()
  try{await link(temp,file+'.gz')}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}
  await syncDirectory(file)
 }finally{await h.close().catch(()=>{});await unlink(temp).catch(()=>{})}
 const saved=await readR36LifecycleBytes(file);must(saved?.equals(raw));return saved!
}
/** Run before any producer starts, with exclusive custody of its existing
 * volume. Preserve every old bundle; unlink plaintext only AFTER the exact
 * compressed copy has been fsynced, reopened and compared byte for byte. A
 * crash at either publication boundary leaves one or two complete copies. */
export async function compactR36PriorBundles(directory:string){
 const base=await realpath(directory),s=await lstat(directory)
 must(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o077)===0)
 let files=0,beforeBytes=0,afterBytes=0
 const digests:string[]=[]
 for(const name of (await readdir(base)).sort()){
  if(!/^lifecycle-prior-[a-f0-9]{64}\.json$/.test(name))continue
  const file=path.join(base,name),raw=await readBytes(file);must(raw)
  const value=JSON.parse(raw!.toString('utf8'))
  must(value?.schema==='R36_LIFECYCLE_PUBLICATION_V1'&&value.request?.action==='record_prior')
  const packed=gzipSync(raw!,{level:6});must(unpack(packed).equals(raw!))
  const old=await readBytes(file+'.gz')
  if(old){must(unpack(old).equals(raw!))}
  else{
   const tmp=file+'.'+randomUUID()+'.gz.tmp',h=await open(tmp,'wx',0o600)
   try{
    await h.writeFile(packed);await h.sync();await h.close()
    try{await link(tmp,file+'.gz')}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}
    await syncDirectory(file)
   }finally{await h.close().catch(()=>{});await unlink(tmp).catch(()=>{})}
  }
  const checked=await readBytes(file+'.gz');must(checked&&unpack(checked).equals(raw!))
  // Recheck the original before removing only its redundant representation.
  must((await readBytes(file))?.equals(raw!));await unlink(file);await syncDirectory(file)
  files++;beforeBytes+=raw!.length;afterBytes+=checked!.length;digests.push(name+':'+hash(raw!))
 }
 return{files,beforeBytes,afterBytes,originalBytesVerified:true,manifestSha256:hash(Buffer.from(digests.join('\n')))}
}
