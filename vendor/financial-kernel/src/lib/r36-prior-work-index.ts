/** Durable housekeeping index only. No certificate, financial right or money
 * fact is stored here. The authenticated issuer remains the archive authority. */
import {DatabaseSync} from 'node:sqlite'
import {lstatSync,openSync,closeSync,realpathSync,fsyncSync,fchownSync} from 'node:fs'
import {opendir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
const valid=(s:string)=>/^(prior\/)?lifecycle-prior-[a-f0-9]{64}\.json$/.test(s)
const must=(v:unknown)=>{if(!v)throw Error('PRIOR_WORK_INDEX_INVALID')}
export type PriorWork={name:string;generation:string;digest:string|null;phase:string;attempts:number}
function database(root:string){
 const base=realpathSync(root),s=lstatSync(root);must(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o077)===0)
 const file=path.join(base,'.prior-work.sqlite')
 try{const fd=openSync(file,'wx',0o600);try{fchownSync(fd,s.uid,s.gid);fsyncSync(fd)}finally{closeSync(fd)}const d=openSync(base,'r');try{fsyncSync(d)}finally{closeSync(d)}}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}
 for(const suffix of ['','-journal','-wal','-shm']){try{const st=lstatSync(file+suffix);must(st.isFile()&&!st.isSymbolicLink()&&(st.mode&0o077)===0)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
 const db=new DatabaseSync(file)
 try{db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA temp_store=MEMORY; PRAGMA auto_vacuum=INCREMENTAL; CREATE TABLE IF NOT EXISTS jobs(name TEXT PRIMARY KEY,generation TEXT NOT NULL,digest TEXT,phase TEXT NOT NULL,due INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS jobs_due ON jobs(due,name) WHERE phase IN ('ready','ack'); CREATE TABLE IF NOT EXISTS meta(name TEXT PRIMARY KEY,value TEXT NOT NULL)");return db}catch(e){db.close();throw e}
}
function use<T>(root:string,fn:(db:DatabaseSync)=>T){const db=database(root);try{return fn(db)}finally{db.close()}}
export function priorWorkLocation(file:string){const parent=path.dirname(file),root=path.basename(parent)==='prior'?path.dirname(parent):parent,name=path.relative(root,file);must(valid(name));return{root,name}}
/** Register BEFORE publishing bytes. A crash leaves an outstanding index item,
 * never an unindexed published original. A pending writer cannot be retired. */
export function beginPriorWork(file:string,digest:string){const {root,name}=priorWorkLocation(file),generation=randomUUID();must(/^[a-f0-9]{64}$/.test(digest));use(root,db=>{
 db.exec('BEGIN IMMEDIATE');try{const old=db.prepare('SELECT digest FROM jobs WHERE name=?').get(name);must(!old?.digest||old.digest===digest);db.prepare("INSERT INTO jobs(name,generation,digest,phase,due) VALUES(?,?,?,'pending',0) ON CONFLICT(name) DO UPDATE SET generation=excluded.generation,digest=excluded.digest,phase='pending',due=0,attempts=0").run(name,generation,digest);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
 });return generation}
export function readyPriorWork(file:string,generation:string){const{root,name}=priorWorkLocation(file);use(root,db=>db.prepare("UPDATE jobs SET phase='ready' WHERE name=? AND generation=? AND phase='pending'").run(name,generation))}
export function selectPriorWork(root:string,now=Date.now()):PriorWork[]{return use(root,db=>db.prepare("SELECT name,generation,digest,phase,attempts FROM jobs WHERE phase IN ('ready','ack') AND due<=? ORDER BY due,name LIMIT 4").all(now) as unknown as PriorWork[])}
export function acknowledgePriorWork(file:string,digest:string):PriorWork|null{const{root,name}=priorWorkLocation(file);return use(root,db=>{
 db.exec('BEGIN IMMEDIATE');try{const row=db.prepare("SELECT name,generation,digest,phase,attempts FROM jobs WHERE name=? AND phase IN ('ready','ack')").get(name) as unknown as PriorWork|undefined;
 if(row){must(row.digest===null||row.digest===digest);db.prepare("UPDATE jobs SET phase='ack',digest=? WHERE name=? AND generation=?").run(digest,name,row.generation)}db.exec('COMMIT');return row??null}catch(e){db.exec('ROLLBACK');throw e}
 })}
export function finishPriorWork(root:string,work:PriorWork){use(root,db=>{db.prepare("DELETE FROM jobs WHERE name=? AND generation=? AND phase='ack'").run(work.name,work.generation);db.exec('PRAGMA incremental_vacuum(8)')})}
export function deferPriorWork(root:string,work:PriorWork,now=Date.now()){use(root,db=>db.prepare('UPDATE jobs SET due=?,attempts=attempts+1 WHERE name=? AND generation=?').run(now+Math.min(300000,5000*2**Math.min(work.attempts,6)),work.name,work.generation))}
/** Once per existing volume, before producers start. Every imported batch is
 * durable; interrupted import is idempotently resumed. Normal cold starts read
 * only the marker, never enumerate the historical directory again. */
export async function importPriorWork(root:string){
 if(use(root,db=>db.prepare("SELECT value FROM meta WHERE name='legacy-import-v1'").get())?.value==='complete')return{imported:0,alreadyComplete:true}
 let imported=0
 for(const relative of ['', 'prior']){
  let dir;try{const directory=path.join(root,relative),st=lstatSync(directory);must(st.isDirectory()&&!st.isSymbolicLink()&&(st.mode&0o077)===0);dir=await opendir(directory)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e}
  let batch:string[]=[]
  const save=()=>{use(root,db=>{db.exec('BEGIN IMMEDIATE');try{const insert=db.prepare("INSERT OR IGNORE INTO jobs(name,generation,digest,phase,due) VALUES(?,?,NULL,'ready',0)");for(const name of batch)imported+=Number(insert.run(name,randomUUID()).changes);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}});batch=[]}
  for await(const e of dir){const name=(relative?relative+'/':'')+e.name.replace(/\.gz$/,'');if(valid(name)){batch.push(name);if(batch.length===128)save()}}
  if(batch.length)save()
 }
 use(root,db=>db.prepare("INSERT OR REPLACE INTO meta VALUES('legacy-import-v1','complete')").run())
 return{imported,alreadyComplete:false}
}
/** Exclusive startup recovery: a writer died after enqueue/before readiness.
 * Existing bytes are still checked and archived through the original issuer. */
export function recoverPriorWriters(root:string){return use(root,db=>{
 let recovered=0
 for(const row of db.prepare("SELECT name,generation FROM jobs WHERE phase='pending'").iterate()){
  const file=path.join(root,String(row.name));must(valid(String(row.name)));let exists=false
  for(const n of [file,file+'.gz']){try{const s=lstatSync(n);must(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o077)===0);exists=true}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
  if(exists)db.prepare("UPDATE jobs SET phase='ready' WHERE name=? AND generation=? AND phase='pending'").run(row.name,row.generation)
  else db.prepare("DELETE FROM jobs WHERE name=? AND generation=? AND phase='pending'").run(row.name,row.generation)
  recovered++
 }
 return recovered
})}
