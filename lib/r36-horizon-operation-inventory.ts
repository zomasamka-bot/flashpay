/** R36 Horizon account operations page-chain validator.
 * Read-only pure validation of supplied pages; NEVER certifies complete history.
 * Cursor gaps cannot be proven absent from an untrusted server response.
 */
export type R36Operation = Readonly<{id?:unknown; paging_token?:unknown; transaction_hash?:unknown; type?:unknown; from?:unknown; to?:unknown; amount?:unknown; asset_type?:unknown; transaction_successful?:unknown}>
export type R36Page = Readonly<{requestedCursor:string|null; records:readonly R36Operation[]; nextCursor:string|null}>
export type R36InventoryResult = Readonly<{outcome:'BLOCKED';reason:string;authorizesRotation:false;observed:number;outbound:number}>
const deny=(reason:string,observed=0,outbound=0):R36InventoryResult=>({outcome:'BLOCKED',reason,authorizesRotation:false,observed,outbound})
const token=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v)
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const wallet=(v:unknown)=>typeof v==='string'&&/^G[A-Z2-7]{55}$/.test(v)
/** The caller must fetch ascending account operations, limit=200, and independently
 * establish the account's creation boundary and finalized upper ledger boundary.
 * The next link alone is NOT evidence of page-chain completeness or finality.
 */
export function inspectR36HorizonOperationPages(walletId:string,pages:readonly R36Page[],maxPages=10000):R36InventoryResult{
 if(!wallet(walletId)||!Array.isArray(pages)||pages.length===0||pages.length>maxPages||!Number.isSafeInteger(maxPages)||maxPages<1)return deny('INVALID_INPUT')
 let expected:string|null=null,previous:bigint|null=null,observed=0,outbound=0
 const ids=new Set<string>(),hashes=new Set<string>()
 for(const page of pages){
  if(!page||page.requestedCursor!==expected||!Array.isArray(page.records)||page.records.length===0||page.records.length>200)return deny('PAGE_CHAIN_INVALID',observed,outbound)
  for(const row of page.records){
   if(!row||!token(row.paging_token)||!token(row.id)||row.id!==row.paging_token||!hash(row.transaction_hash)||typeof row.type!=='string')return deny('INVALID_OPERATION',observed,outbound)
   const n=BigInt(row.paging_token)
   if(previous!==null&&n<=previous)return deny('CURSOR_ORDER_OR_DUPLICATE',observed,outbound)
   if(ids.has(row.id))return deny('DUPLICATE_OPERATION',observed,outbound)
   ids.add(row.id);previous=n;observed++
   if(row.type==='payment'&&row.from===walletId){
    if(!wallet(row.to)||row.asset_type!=='native'||typeof row.amount!=='string'||!/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(row.amount)||row.transaction_successful!==true)return deny('INVALID_OUTBOUND_PAYMENT',observed,outbound)
    outbound++;hashes.add(row.transaction_hash)
   }else if(row.from===walletId&&row.type!=='payment'){
    // Account operations include other value-moving operations; never silently skip.
    return deny('UNCLASSIFIED_SOURCE_OPERATION',observed,outbound)
   }
  }
  if(page.nextCursor!==page.records[page.records.length-1].paging_token)return deny('NEXT_CURSOR_MISMATCH',observed,outbound)
  expected=page.nextCursor
 }
 // Even with contiguous returned pages, missing pages / account-creation coverage,
 // Horizon authenticity, ledger finality, and transaction-level coverage remain unproven.
 return deny('PAGE_CANDIDATES_ONLY_COMPLETENESS_UNPROVEN',observed,outbound)
}
