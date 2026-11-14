/** Lossless acquisition optimization, never a financial checkpoint or verdict.
 * Every row location/version is read again inside the caller's checked physical
 * REPEATABLE READ snapshot. Changed/inserted rows are fetched on that connection;
 * deleted rows disappear. The original complete snapshot and reviewer remain.
 */
type Row=Record<string,unknown>
type Tx={unsafe(sql:string):Promise<Row[]>}
type Entry={at:number;epoch:bigint;xmax:bigint;scope:string;rows:Map<string,Row>;bytes:number}
const caches=new WeakMap<object,Map<string,Entry>>()
const BUDGET=96*1024*1024,TTL=60000
const version=(r:Row)=>String(r.__r36_table)+':'+String(r.__r36_ctid)+':'+String(r.__r36_xmin)
function valid(r:Row){return /^\d+$/.test(String(r.__r36_table))&&/^\(\d+,\d+\)$/.test(String(r.__r36_ctid))&&/^\d+$/.test(String(r.__r36_xmin))}
export async function readR36VersionedRows(owner:object,tx:Tx,query:string,session:Row):Promise<Row[]>{
 const match=/^SELECT ([\s\S]+) FROM public\.([a-z0-9_]+)( WHERE [\s\S]+?)? ORDER BY ([a-z0-9_,]+) LIMIT (20001|101)$/.exec(query)
 const parts=typeof session.snapshot==='string'?session.snapshot.split(':'):[]
 if(!match||parts.length!==3||!/^\d+$/.test(parts[1]))throw Error('SOURCE_VERSION_QUERY_CONTRACT')
 const [,columns,table,where='',order,limit]=match,xmax=BigInt(parts[1]),epoch=xmax/4294967296n,now=Date.now(),scope=String(session.version_scope)
 if(typeof session.version_scope!=='string'||!scope)throw Error('SOURCE_VERSION_SCOPE')
 let cache=caches.get(owner);if(!cache){cache=new Map();caches.set(owner,cache)}
 let previous=cache.get(query)
 if(previous&&(now<previous.at||now-previous.at>=TTL||previous.epoch!==epoch||xmax<previous.xmax||previous.scope!==scope)){cache.delete(query);previous=undefined}
 const stamp='__r36_table::text,__r36_ctid::text,__r36_xmin::text'
 if(!previous){
  const fetched=await tx.unsafe(`SELECT ${columns},${stamp} FROM r36_evidence_source.${table}${where} ORDER BY ${order} LIMIT ${limit}`)
  if(fetched.length>=Number(limit)||fetched.some(r=>!valid(r)))throw Error('SOURCE_ROWS_BOUNDED')
  const rows=new Map<string,Row>(),out:Row[]=[];let bytes=0
  for(const r of fetched){const k=version(r);if(rows.has(k))throw Error('SOURCE_VERSION_DUPLICATE');const {__r36_table,__r36_ctid,__r36_xmin,...value}=r;rows.set(k,value);bytes+=Buffer.byteLength(JSON.stringify(value))+k.length+128;out.push(structuredClone(value))}
  if(bytes<=BUDGET){cache.delete(query);cache.set(query,{at:now,epoch,xmax,scope,rows,bytes});let total=[...cache.values()].reduce((n,e)=>n+e.bytes,0);while(total>BUDGET){const key=cache.keys().next().value!;total-=cache.get(key)!.bytes;cache.delete(key)}}
  return out
 }
 const fingerprints=await tx.unsafe(`SELECT ${stamp} FROM r36_evidence_source.${table}${where} ORDER BY ${order} LIMIT ${limit}`)
 if(fingerprints.length>=Number(limit)||fingerprints.some(r=>!valid(r)))throw Error('SOURCE_ROWS_BOUNDED')
 const keys=fingerprints.map(version)
 if(new Set(keys).size!==keys.length)throw Error('SOURCE_VERSION_DUPLICATE')
 const missing=fingerprints.filter(r=>!previous?.rows.has(version(r))),fresh=new Map<string,Row>()
 // Restrict only by PostgreSQL's own validated tuple locations. Never interpolate
 // a payment identifier or caller-provided SQL. Same snapshot prevents CTID reuse.
 for(let offset=0;offset<missing.length;offset+=500){
  const group=missing.slice(offset,offset+500),byTable=new Map<string,string[]>()
  for(const r of group){const id=String(r.__r36_table);const ids=byTable.get(id)??[];ids.push("'"+r.__r36_ctid+"'::tid");byTable.set(id,ids)}
  const locations=[...byTable].map(([id,ids])=>`(__r36_table=${id}::oid AND __r36_ctid=ANY(ARRAY[${ids.join(',')}]))`).join(' OR ')
  const rows=await tx.unsafe(`SELECT ${columns},${stamp} FROM r36_evidence_source.${table}${where?where+' AND':' WHERE'} (${locations}) ORDER BY ${order}`)
  if(rows.length!==group.length)throw Error('SOURCE_VERSION_VISIBILITY')
  const expected=new Set(group.map(version))
  for(const r of rows){const k=version(r);if(!valid(r)||!expected.has(k)||fresh.has(k))throw Error('SOURCE_VERSION_CONFLICT');const {__r36_table,__r36_ctid,__r36_xmin,...value}=r;fresh.set(k,value)}
 }
 const rows=new Map<string,Row>(),out:Row[]=[];let bytes=0
 for(const k of keys){const r=fresh.get(k)??previous?.rows.get(k);if(!r)throw Error('SOURCE_VERSION_MISSING');rows.set(k,r);bytes+=Buffer.byteLength(JSON.stringify(r))+k.length+128;out.push(structuredClone(r))}
 // No state is retained until this entire table has been reconstructed exactly.
 if(bytes<=BUDGET){cache.delete(query);cache.set(query,{at:now,epoch,xmax,scope,rows,bytes});let total=[...cache.values()].reduce((n,e)=>n+e.bytes,0);while(total>BUDGET){const key=cache.keys().next().value!;total-=cache.get(key)!.bytes;cache.delete(key)}}
 return out
}
