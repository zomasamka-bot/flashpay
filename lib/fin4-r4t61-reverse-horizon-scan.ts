import 'server-only'

const HORIZON_BASE_URL='https://api.testnet.minepi.com'
export const FIN4_R4T61_SOURCE_WALLET='GCVYA2KC6ANJOW4OMOSUKFLSBMZDYQWZ4S6HA654MIWHG6NZC4ZZOVD5' as const
export const FIN4_R4T61_WINDOW_START='2026-10-05T08:30:00.000Z' as const
export const FIN4_R4T61_WINDOW_END='2026-10-05T15:30:00.000Z' as const
const TARGET_AMOUNTS=new Set(['1.4000000','1.7000000'])
const MAX_PAGES=20

type RecordLike=Record<string,unknown>
const isRecord=(v:unknown):v is RecordLike=>typeof v==='object'&&v!==null&&!Array.isArray(v)

export async function readFin4R4T61ReverseHorizonScan(){
  const headers={Accept:'application/json'}
  let url=`${HORIZON_BASE_URL}/accounts/${encodeURIComponent(FIN4_R4T61_SOURCE_WALLET)}/payments?order=desc&limit=200`
  const seen=new Set<string>()
  const matches:Array<{createdAt:string;transactionHash:string;from:string;to:string;amount:string;assetType:string;operationId:string}> = []
  let pagesRead=0
  let reachedBeforeWindow=false

  while(pagesRead<MAX_PAGES){
    if(seen.has(url))return fail('PAGINATION_LOOP',pagesRead,matches)
    seen.add(url)
    let response:Response
    try{response=await fetch(url,{headers,cache:'no-store'})}catch{return fail('HORIZON_FETCH_FAILED',pagesRead,matches)}
    if(response.status!==200)return fail(`HORIZON_HTTP_${response.status}`,pagesRead,matches)
    let body:unknown
    try{body=await response.json()}catch{return fail('HORIZON_JSON_INVALID',pagesRead,matches)}
    if(!isRecord(body)||!isRecord(body._embedded)||!Array.isArray(body._embedded.records)||!isRecord(body._links)||!isRecord(body._links.next)||typeof body._links.next.href!=='string')
      return fail('HORIZON_PAGE_MALFORMED',pagesRead,matches)
    pagesRead++
    for(const raw of body._embedded.records){
      if(!isRecord(raw))return fail('HORIZON_RECORD_MALFORMED',pagesRead,matches)
      const createdAt=raw.created_at, type=raw.type, from=raw.from, to=raw.to, amount=raw.amount, assetType=raw.asset_type, tx=raw.transaction_hash, id=raw.id
      if(typeof createdAt!=='string'||!Number.isFinite(Date.parse(createdAt)))return fail('HORIZON_RECORD_TIME_INVALID',pagesRead,matches)
      if(createdAt<FIN4_R4T61_WINDOW_START){reachedBeforeWindow=true;continue}
      if(createdAt>FIN4_R4T61_WINDOW_END)continue
      if(type!=='payment'||from!==FIN4_R4T61_SOURCE_WALLET||assetType!=='native'||typeof amount!=='string'||!TARGET_AMOUNTS.has(amount))continue
      if(typeof to!=='string'||!to.trim()||typeof tx!=='string'||!/^[0-9a-f]{64}$/.test(tx)||typeof id!=='string'||!id.trim())
        return fail('MATCH_IDENTITY_INVALID',pagesRead,matches)
      matches.push({createdAt,transactionHash:tx,from,to,amount,assetType,operationId:id})
    }
    if(reachedBeforeWindow)break
    url=body._links.next.href
    if(!url.startsWith(`${HORIZON_BASE_URL}/`))return fail('PAGINATION_ORIGIN_INVALID',pagesRead,matches)
  }
  if(!reachedBeforeWindow)return fail('WINDOW_NOT_EXHAUSTIVELY_SCANNED',pagesRead,matches)
  matches.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.operationId.localeCompare(b.operationId))
  return {
    ok:true as const,action:'fin4-r4t61-reverse-horizon-read-only-scan' as const,
    authority:'horizon_account_payments_reverse_scan' as const,sourceWallet:FIN4_R4T61_SOURCE_WALLET,
    window:{start:FIN4_R4T61_WINDOW_START,end:FIN4_R4T61_WINDOW_END},targetAmounts:['1.4000000','1.7000000'] as const,
    pagesRead,reachedBeforeWindow:true as const,matches,matchCount:matches.length,
    mutationContract:{postgresReadExecuted:false,postgresMutationExecuted:false,redisReadExecuted:false,redisMutationExecuted:false,piPlatformApiExecuted:false,piMutationExecuted:false,horizonReadExecuted:true,horizonSubmitExecuted:false,financialAuthorityMutated:false} as const,
  }
}
function fail(reason:string,pagesRead:number,matches:unknown[]){return{ok:false as const,action:'fin4-r4t61-reverse-horizon-read-only-scan' as const,reason,pagesRead,partialMatchCount:matches.length,mutationContract:{postgresReadExecuted:false,postgresMutationExecuted:false,redisReadExecuted:false,redisMutationExecuted:false,piPlatformApiExecuted:false,piMutationExecuted:false,horizonReadExecuted:true,horizonSubmitExecuted:false,financialAuthorityMutated:false} as const}}
