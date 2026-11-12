import {financialHorizonOrigin,financialNetwork} from './financial-network'
/** Append original Horizon observations to a policy-pinned history prefix.
 * Read-only acquisition; does not certify completeness, sign, or authorize money.
 * The independent snapshot reviewer still verifies XDR/results/accounting.
 */
import type {R36ObservedHistory} from './r36-live-evidence-producer'
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
const operationBodies=new WeakMap<typeof fetch,Map<string,{at:number;body:string}>>()
const operationKey=(t:Row)=>JSON.stringify(t)
function currentOperations(fetcher:typeof fetch){
 let cache=operationBodies.get(fetcher)
 if(!cache){cache=new Map();operationBodies.set(fetcher,cache)}
 const now=Date.now()
 for(const [key,value] of cache)if(now<value.at||now-value.at>=60000)cache.delete(key)
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
  Number(policy.maxNewTransactions)<=(paginated?19999:200)&&(!paginated||(Number.isSafeInteger(policy.maxPages)&&Number(policy.maxPages)>=1&&Number(policy.maxPages)<=100)), 'LIVE_HISTORY_POLICY')
 const h=JSON.parse(JSON.stringify(prefix)) as R36ObservedHistory
 must(h.network===financialNetwork()&&/^G[A-Z2-7]{55}$/.test(h.wallet)&&h.transactions.length>0&&h.transactions.length<=20000&&h.transactions.length===h.operations.length&&uint(h.cutoffLedger)&&hex(h.cutoffHash),'LIVE_HISTORY_PREFIX')
 const tail=h.transactions[h.transactions.length-1];must(uint(tail.paging_token)&&hex(tail.hash),'LIVE_HISTORY_ORIGINAL_CURSOR_REQUIRED')
 const before=await read(fetcher,'/accounts/'+h.wallet)
 must(before.account_id===h.wallet&&uint(String(before.last_modified_ledger)),'LIVE_HISTORY_ACCOUNT')
 const seen=new Set(h.transactions.map(t=>t.hash));let cursor=BigInt(tail.paging_token)
 const cache=currentOperations(fetcher),observed=new Map<string,Row>()
 let added=0,complete=false
 for(let pageNumber=0;pageNumber<(paginated?Number(policy.maxPages):1);pageNumber++){
  const page=records(await read(fetcher,'/accounts/'+h.wallet+'/transactions?order=asc&limit=200&include_failed=true&cursor='+cursor))
  must(page.length<=200&&(paginated||page.length<200)&&added+page.length<=Number(policy.maxNewTransactions)&&h.transactions.length+page.length<=20000,'LIVE_HISTORY_DELTA_BOUND')
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
    const key=operationKey(t),cached=cache.get(key)
    const ops=cached?[JSON.parse(cached.body) as Row]:records(await read(fetcher,'/transactions/'+t.hash+'/operations?order=asc&limit=200&include_failed=true'))
    must(ops.length===1&&ops[0].transaction_hash===t.hash&&ops[0].transaction_successful===t.successful,'LIVE_HISTORY_OPERATION_BINDING')
    if(!cached)observed.set(key,ops[0])
    return ops[0]
   }))
   h.transactions.push(...batch);h.operations.push(...operations)
  }
  added+=page.length
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
 for(const [key,body] of observed){cache.set(key,{at:Date.now(),body:JSON.stringify(body)});while(cache.size>512)cache.delete(cache.keys().next().value!)}
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
