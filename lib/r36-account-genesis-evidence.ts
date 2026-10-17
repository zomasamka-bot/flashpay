/** Read-only Pi Testnet account-creation candidate; NEVER historical completeness proof.
 * An account's earliest returned operation may be truncated by Horizon retention.
 * This function never confers authority, even on a matching create_account record.
 */
export type R36GenesisCandidate = Readonly<{
 outcome:'BLOCKED'; reason:string; authorizesRotation:false;
 walletId:string; creationLedger:number|null; creationTransactionHash:string|null;
 operationId:string|null
}>
const ORIGIN='https://api.testnet.minepi.com'
const wallet=(v:unknown):v is string=>typeof v==='string'&&/^G[A-Z2-7]{55}$/.test(v)
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const cursor=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v)
const ledger=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0
const blocked=(walletId:string,reason:string,creationLedger:number|null=null,creationTransactionHash:string|null=null,operationId:string|null=null):R36GenesisCandidate=>({outcome:'BLOCKED',reason,authorizesRotation:false,walletId,creationLedger,creationTransactionHash,operationId})
export async function acquireR36AccountGenesisCandidate(walletId:string,options:{fetcher?:typeof fetch;timeoutMs?:number}={}):Promise<R36GenesisCandidate>{
 if(!wallet(walletId))return blocked(String(walletId),'INVALID_WALLET')
 const timeout=options.timeoutMs??8000
 if(!Number.isSafeInteger(timeout)||timeout<100||timeout>30000)return blocked(walletId,'INVALID_TIMEOUT')
 const fetcher=options.fetcher??fetch
 const get=async(path:string):Promise<unknown>=>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeout)
  try{
   const response=await fetcher(new URL(path,ORIGIN).toString(),{method:'GET',redirect:'error',signal:abort.signal,headers:{accept:'application/json'}})
   if(!response.ok)throw Error('HTTP_'+response.status)
   return await response.json() as unknown
  }finally{clearTimeout(timer)}
 }
 try{
  const first=await get(`/accounts/${walletId}/operations?order=asc&limit=1`)
  if(!first||typeof first!=='object')return blocked(walletId,'INVALID_FIRST_PAGE')
  const records=(first as {_embedded?:{records?:unknown}})._embedded?.records
  if(!Array.isArray(records)||records.length!==1)return blocked(walletId,'FIRST_OPERATION_MISSING_OR_TRUNCATED')
  const raw=records[0]
  if(!raw||typeof raw!=='object')return blocked(walletId,'INVALID_FIRST_OPERATION')
  const op=raw as Record<string,unknown>
  if(!cursor(op.paging_token)||op.id!==op.paging_token||!hash(op.transaction_hash)||!ledger(op.ledger))return blocked(walletId,'INVALID_FIRST_OPERATION')
  if(op.type!=='create_account'||op.account!==walletId)return blocked(walletId,'GENESIS_NOT_ESTABLISHED_BY_FIRST_OPERATION')
  if(typeof op.funder!=='string'||!wallet(op.funder)||op.funder===walletId)return blocked(walletId,'INVALID_CREATION_FUNDER')
  // Fetch the transaction by its validated hash to corroborate success and ledger.
  const tx=await get(`/transactions/${op.transaction_hash}`)
  if(!tx||typeof tx!=='object')return blocked(walletId,'INVALID_CREATION_TRANSACTION')
  const t=tx as Record<string,unknown>
  if(t.hash!==op.transaction_hash||t.successful!==true||t.ledger!==op.ledger)return blocked(walletId,'CREATION_TRANSACTION_MISMATCH')
  // A matching creation record is still not proof of full history, finality, or accounting.
  return blocked(walletId,'CREATION_CANDIDATE_OBSERVED_NOT_COMPLETE_HISTORY',op.ledger,op.transaction_hash,op.id)
 }catch{return blocked(walletId,'GENESIS_FETCH_FAILED')}
}
