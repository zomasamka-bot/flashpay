/** R36 fixed-origin, read-only boundary acquisition. Never a finality or genesis certificate. */
export type BoundaryCandidate = Readonly<{outcome:'BLOCKED';reason:string;authorizesRotation:false;network:'Pi Testnet';walletId:string;observedLedger:number|null;observedLedgerHash:string|null;accountSequence:string|null}>
const ORIGIN='https://api.testnet.minepi.com'
const wallet=(v:unknown):v is string=>typeof v==='string'&&/^G[A-Z2-7]{55}$/.test(v)
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0
const deny=(walletId:string,reason:string,observedLedger:number|null=null,observedLedgerHash:string|null=null,accountSequence:string|null=null):BoundaryCandidate=>({outcome:'BLOCKED',reason,authorizesRotation:false,network:'Pi Testnet',walletId,observedLedger,observedLedgerHash,accountSequence})
/** GET-only, no redirects; fetcher is test injection, never an origin override. */
export async function acquireR36BoundaryCandidate(walletId:string,opts:{fetcher?:typeof fetch;timeoutMs?:number}={}):Promise<BoundaryCandidate>{
 if(!wallet(walletId))return deny(String(walletId),'INVALID_WALLET')
 const timeoutMs=opts.timeoutMs??8000
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)return deny(walletId,'INVALID_TIMEOUT')
 const fetcher=opts.fetcher??fetch
 const get=async(path:string):Promise<unknown>=>{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs)
  try{
   const response=await fetcher(new URL(path,ORIGIN).toString(),{method:'GET',redirect:'error',signal:controller.signal,headers:{accept:'application/json'}})
   if(!response.ok)throw Error('HTTP_ERROR')
   return await response.json() as unknown
  }finally{clearTimeout(timer)}
 }
 try{
  // Horizon ledger collection's latest record is an observed head, NOT independently finalized.
  const ledgers=await get('/ledgers?order=desc&limit=1')
  if(!ledgers||typeof ledgers!=='object')return deny(walletId,'INVALID_LEDGER_BODY')
  const records=(ledgers as {_embedded?:{records?:unknown}})._embedded?.records
  if(!Array.isArray(records)||records.length!==1)return deny(walletId,'INVALID_LEDGER_RECORDS')
  const ledger=records[0] as Record<string,unknown>
  if(!integer(ledger.sequence)||!hash(ledger.hash))return deny(walletId,'INVALID_LEDGER_BOUNDARY')
  const sequence=ledger.sequence,ledgerHash=ledger.hash
  const account=await get('/accounts/'+walletId)
  if(!account||typeof account!=='object')return deny(walletId,'INVALID_ACCOUNT_BODY',sequence,ledgerHash)
  const a=account as Record<string,unknown>
  if(a.account_id!==walletId||typeof a.sequence!=='string'||!/^[0-9]+$/.test(a.sequence))return deny(walletId,'ACCOUNT_IDENTITY_OR_SEQUENCE_MISMATCH',sequence,ledgerHash)
  // Race: head and account responses are separate GETs, with no common ledger snapshot.
  return deny(walletId,'OBSERVED_HEAD_AND_ACCOUNT_NOT_FINALITY_OR_GENESIS_PROOF',sequence,ledgerHash,a.sequence)
 }catch{return deny(walletId,'BOUNDARY_FETCH_FAILED')}
}
