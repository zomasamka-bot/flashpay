import {financialHorizonOrigin,financialNetwork} from './financial-network'
/** Append original Horizon observations to a policy-pinned history prefix.
 * Read-only acquisition; does not certify completeness, sign, or authorize money.
 * The independent snapshot reviewer still verifies XDR/results/accounting.
 */
import type {R36ObservedHistory} from './r36-live-evidence-producer'
import {createHash} from 'node:crypto'
type Row=Record<string,unknown>
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const uint=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,39})$/.test(v)
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)
function must(v:unknown,reason:string):asserts v{if(!v)throw Error(reason)}
async function read(fetcher:typeof fetch,path:string):Promise<Row>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
 try{return await Promise.race([(async()=>{
 const r=await fetcher(financialHorizonOrigin()+path,{method:'GET',redirect:'error',cache:'no-store',signal:controller.signal})
 must(r.status===200&&!r.redirected&&r.body,'LIVE_HISTORY_PROVIDER_UNAVAILABLE')
 const reader=r.body.getReader(),parts:Uint8Array[]=[];let size=0
 try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;must(size<=2_000_000,'LIVE_HISTORY_RESPONSE_SIZE');parts.push(x.value)}}finally{await reader.cancel().catch(()=>{})}
 const v:unknown=JSON.parse(Buffer.concat(parts).toString('utf8'));must(object(v),'LIVE_HISTORY_RESPONSE');return v
 })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('LIVE_HISTORY_DEADLINE'))},8000)})])}
 finally{if(timer)clearTimeout(timer)}
}
const records=(v:Row):Row[]=>{must(object(v._embedded)&&Array.isArray(v._embedded.records)&&v._embedded.records.every(object),'LIVE_HISTORY_PAGE');return v._embedded.records}
const accountIdentity=(a:Row)=>JSON.stringify([a.account_id,a.sequence,a.last_modified_ledger,a.balances,a.signers,a.thresholds,a.flags])
// Cache immutable operation bodies only after a complete, unchanged-account
// observation. Every invocation still reads the current account, transaction
// pages and cutoff ledger. This is never a cache of finality or financial rights.
type OperationBody={at:number;body:string;bytes:number}
type OperationCache={entries:Map<string,OperationBody>;bytes:number}
const OPERATION_CACHE_BYTES=96*1024*1024,OPERATION_CACHE_ENTRIES=40000
const operationBodies=new WeakMap<typeof fetch,OperationCache>()
// Original observations only: a complete prior read is a resumable acquisition
// cursor, not a financial clearance. The full independent reviewer still runs.
// Re-read its original ledger hash before using the prefix. A restart, changed
// policy/facts/provider or eviction requires fresh acquisition. A failed read
// never advances this cursor.
type HistoryCursor={history:R36ObservedHistory;bytes:number}
const historyCursors=new WeakMap<typeof fetch,Map<string,HistoryCursor>>()
const HISTORY_CURSOR_BYTES=96*1024*1024
function removeOperation(cache:OperationCache,key:string){const old=cache.entries.get(key);if(old){cache.bytes-=old.bytes;cache.entries.delete(key)}}
const operationKey=(t:Row)=>JSON.stringify(t)
function currentOperations(fetcher:typeof fetch){
 let cache=operationBodies.get(fetcher)
 if(!cache){cache={entries:new Map(),bytes:0};operationBodies.set(fetcher,cache)}
 const now=Date.now()
 for(const [key,value] of cache.entries)if(now<value.at||now-value.at>=60000)removeOperation(cache,key)
 return cache
}
/** No provider next-link is followed. V1 retains its original one-page contract.
 * An explicitly enrolled V2 policy permits bounded cursor pagination. A full
 * final page is never treated as completeness; a short/empty page is required.
 * The independent financial reviewer and its total-history bounds remain intact.
 */
export async function appendR36LiveHistory(prefix:R36ObservedHistory,policy:unknown,fetcher:typeof fetch):Promise<R36ObservedHistory>{
 return appendHistory(prefix,policy,fetcher,4)
}
async function appendHistory(prefix:R36ObservedHistory,policy:unknown,fetcher:typeof fetch,operationWidth:number):Promise<R36ObservedHistory>{
 must(object(policy),'LIVE_HISTORY_POLICY')
 const paginated=policy.schema==='R36_HORIZON_PAGINATED_DELTA_V2'
 must(Object.keys(policy).sort().join(',')===(paginated?'maxNewTransactions,maxPages,schema':'maxNewTransactions,schema')&&
  (paginated||policy.schema==='R36_HORIZON_BOUNDED_DELTA_V1')&&Number.isSafeInteger(policy.maxNewTransactions)&&Number(policy.maxNewTransactions)>=1&&
  Number(policy.maxNewTransactions)<=(paginated?40000:200)&&(!paginated||(Number.isSafeInteger(policy.maxPages)&&Number(policy.maxPages)>=1&&Number(policy.maxPages)<=201)), 'LIVE_HISTORY_POLICY')
 const cursorKey=createHash('sha256').update(JSON.stringify([prefix,policy])).digest('hex')
 let cursors=historyCursors.get(fetcher);if(!cursors){cursors=new Map();historyCursors.set(fetcher,cursors)}
 const retained=cursors.get(cursorKey)
 const h=JSON.parse(JSON.stringify(retained?.history??prefix)) as R36ObservedHistory
 must(h.network===financialNetwork()&&/^G[A-Z2-7]{55}$/.test(h.wallet)&&h.transactions.length>0&&h.transactions.length<=40001&&h.transactions.length===h.operations.length&&uint(h.cutoffLedger)&&hex(h.cutoffHash),'LIVE_HISTORY_PREFIX')
 const tail=h.transactions[h.transactions.length-1];must(uint(tail.paging_token)&&hex(tail.hash),'LIVE_HISTORY_ORIGINAL_CURSOR_REQUIRED')
 const before=await read(fetcher,'/accounts/'+h.wallet)
 must(before.account_id===h.wallet&&uint(String(before.last_modified_ledger)),'LIVE_HISTORY_ACCOUNT')
 if(retained){
  const anchor=await read(fetcher,'/ledgers/'+h.cutoffLedger)
  must(String(anchor.sequence)===h.cutoffLedger&&anchor.hash===h.cutoffHash&&BigInt(String(before.last_modified_ledger))>=BigInt(h.cutoffLedger),'LIVE_HISTORY_RETAINED_CUTOFF_CHANGED')
 }
 const seen=new Set(h.transactions.map(t=>t.hash));let cursor=BigInt(tail.paging_token)
 const cache=currentOperations(fetcher),observed=new Map<string,Row>()
 let added=0,complete=false
 for(let pageNumber=0;pageNumber<(paginated?Number(policy.maxPages):1);pageNumber++){
  const page=records(await read(fetcher,'/accounts/'+h.wallet+'/transactions?order=asc&limit=200&include_failed=true&cursor='+cursor))
  must(page.length<=200&&(paginated||page.length<200)&&h.transactions.length-prefix.transactions.length+page.length<=Number(policy.maxNewTransactions)&&h.transactions.length+page.length<=40001,'LIVE_HISTORY_DELTA_BOUND')
  for(const t of page){
   must(hex(t.hash)&&!seen.has(t.hash)&&uint(t.paging_token)&&BigInt(t.paging_token)>cursor&&Number(t.operation_count)===1&&typeof t.successful==='boolean'&&uint(String(t.ledger))&&BigInt(String(t.ledger))<=BigInt(String(before.last_modified_ledger)),'LIVE_HISTORY_DELTA_IDENTITY')
   seen.add(t.hash);cursor=BigInt(t.paging_token)
  }
  // Four read-only requests at most. Persist nothing until the complete set and
  // unchanged account cutoff have been verified. Failures leave prefix intact.
  const width=paginated?operationWidth:1
  for(let offset=0;offset<page.length;offset+=width){
   const batch=page.slice(offset,offset+width)
   const operations=await Promise.all(batch.map(async t=>{
    const key=operationKey(t),cached=cache.entries.get(key)
    const ops=cached?[JSON.parse(cached.body) as Row]:records(await read(fetcher,'/transactions/'+t.hash+'/operations?order=asc&limit=200&include_failed=true'))
    must(ops.length===1&&ops[0].transaction_hash===t.hash&&ops[0].transaction_successful===t.successful,'LIVE_HISTORY_OPERATION_BINDING')
    if(!cached)observed.set(key,ops[0])
    return ops[0]
   }))
   h.transactions.push(...batch);h.operations.push(...operations)
  }
  added+=page.length
  must(h.transactions.length-prefix.transactions.length<(paginated?Number(policy.maxPages):1)*200,'LIVE_HISTORY_PAGINATION_INCOMPLETE')
  if(page.length<200){complete=true;break}
 }
 must(complete,'LIVE_HISTORY_PAGINATION_INCOMPLETE')
 const after=await read(fetcher,'/accounts/'+h.wallet)
 must(accountIdentity(before)===accountIdentity(after),'LIVE_HISTORY_ACCOUNT_CHANGED_RETRY_READ_ONLY')
 const cutoff=BigInt(String(after.last_modified_ledger))>BigInt(h.cutoffLedger)?String(after.last_modified_ledger):h.cutoffLedger,ledger=await read(fetcher,'/ledgers/'+cutoff)
 must(String(ledger.sequence)===cutoff&&hex(ledger.hash),'LIVE_HISTORY_CUTOFF')
 if(cutoff===h.cutoffLedger)must(ledger.hash===h.cutoffHash,'LIVE_HISTORY_PINNED_CUTOFF_CHANGED')
 h.cutoffLedger=cutoff;h.cutoffHash=ledger.hash;h.accountAtCutoff=after
 const inventory=h.walletInventory.filter(x=>x.wallet===h.wallet);must(inventory.length===1,'LIVE_HISTORY_INVENTORY');inventory[0].lastLedger=cutoff
 // No entries from a failed or incomplete observation can escape this call.
 for(const [key,body] of observed){
  const encoded=JSON.stringify(body),bytes=2*(Buffer.byteLength(key)+Buffer.byteLength(encoded))+256
  // Bounded raw observations only. Keep the original 60-second lifetime and
  // full transaction identity key; current pages/account/cutoff remain uncached.
  if(bytes>OPERATION_CACHE_BYTES)continue
  removeOperation(cache,key);cache.entries.set(key,{at:Date.now(),body:encoded,bytes});cache.bytes+=bytes
  while(cache.entries.size>OPERATION_CACHE_ENTRIES||cache.bytes>OPERATION_CACHE_BYTES)removeOperation(cache,cache.entries.keys().next().value!)
 }
 const bytes=Buffer.byteLength(JSON.stringify(h))*2
 if(bytes<=HISTORY_CURSOR_BYTES){cursors.delete(cursorKey);cursors.set(cursorKey,{history:JSON.parse(JSON.stringify(h)),bytes});let total=[...cursors.values()].reduce((n,x)=>n+x.bytes,0);while(total>HISTORY_CURSOR_BYTES||cursors.size>32){const key=cursors.keys().next().value!;total-=cursors.get(key)!.bytes;cursors.delete(key)}}
 return h
}

export async function appendR36LiveHistories(prefixes:R36ObservedHistory[],policy:unknown,fetcher:typeof fetch):Promise<R36ObservedHistory[]>{
 must(Array.isArray(prefixes)&&prefixes.length>0&&prefixes.length<=32,'LIVE_HISTORY_SCOPE')
 const out:R36ObservedHistory[]=[]
 // Two independent wallet observations at most, each with two operation reads.
 // The combined maximum remains four provider requests. Every wallet retains
 // its own before/after consistency check and the final full inventory check.
 for(let offset=0;offset<prefixes.length;offset+=2){
  const group=prefixes.slice(offset,offset+2)
  const results=await Promise.allSettled(group.map(prefix=>appendHistory(prefix,policy,fetcher,group.length===1?4:2)))
  for(const result of results){if(result.status==='rejected')throw result.reason;out.push(result.value)}
 }
 const inventory:Row[]=out[0].walletInventory.map(x=>{const matches=out.filter(h=>h.wallet===x.wallet);must(matches.length===1,'LIVE_HISTORY_SCOPE');return {...x,lastLedger:matches[0].cutoffLedger}})
 must(inventory.length===out.length&&new Set(inventory.map(x=>x.wallet)).size===out.length,'LIVE_HISTORY_SCOPE')
 for(const h of out)h.walletInventory=JSON.parse(JSON.stringify(inventory))
 return out
}
