/** Nonfinancial publication after the ORIGINAL independently signed terminal
 * review. Source drift rolls back only this optimization; it cannot change the
 * original closure, admit a transfer, or advance an unverified checkpoint. */
import {deriveR36HistoryCheckpoint,r36HistoryCheckpointDigest,type R36CheckpointContext} from './r36-certified-history'
import {readR36IndexedRows} from './r36-source-index'
import {r36SnapshotDigest} from './r36-evidence-snapshot'
type Row=Record<string,unknown>
type Tx={unsafe(sql:string,args?:unknown[]):Promise<Row[]>}
export async function publishR36HistoryCheckpoint(tx:Tx,policy:string,wallet:string,closure:string,artifacts:Record<string,Row>,profile:Row,parent?:R36CheckpointContext):Promise<Row>{
 const installed=await tx.unsafe("SELECT to_regclass('public.r36_history_enrollments') IS NOT NULL installed");if(installed[0]?.installed!==true)return{status:'NOT_INSTALLED'}
 const enrolled=await tx.unsafe("SELECT 1 FROM public.r36_history_enrollments WHERE policy_digest=$1 AND source_wallet=$2 AND NOT revoked AND version='R36_CERTIFIED_HISTORY_CHECKPOINT_V1'",[policy,wallet])
 if(enrolled.length!==1)return{status:'NOT_ENROLLED'}
 const history=artifacts.wallet_history.snapshot as Row,accounting=artifacts.accounting.snapshot as Row,scope=artifacts.accounting.executionScope as Row
 if(!Array.isArray(history.transactions)||history.transactions.length===0)return{status:'NO_NEW_HISTORY'}
 try{
  const rows=await readR36IndexedRows({unsafe:q=>tx.unsafe(q)})
  if(!scope||scope.sourceRowsDigest!==r36SnapshotDigest(rows))throw Error('CHECKPOINT_SOURCE_CHANGED')
  const point=deriveR36HistoryCheckpoint({policyDigest:policy,executionScopeDigest:String(profile.executionScopeDigest),closureDigest:closure,sourceRowsDigest:String(scope.sourceRowsDigest),originalCursor:String(history.originalCursor),artifacts,parent})
  if(point.sourceWallet!==wallet)throw Error('CHECKPOINT_WALLET')
  const credits=(accounting.merchantBalances as Row[]).map(b=>{
   const ids=new Set(rows.settlements.filter(s=>s.merchant_uid===b.merchantUid).map(s=>s.merchant_id))
   const known=parent?.credits.find(r=>r.merchantUid===b.merchantUid);if(known?.merchantId)ids.add(known.merchantId)
   if(ids.size!==1)throw Error('CHECKPOINT_MERCHANT_MAPPING')
   return{...b,merchantId:[...ids][0]}
  })
  const digest=r36HistoryCheckpointDigest(point),text=JSON.stringify(point)
  const recorded=await tx.unsafe('SELECT public.r36_publish_history_fact($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',[policy,wallet,closure,text,digest,JSON.stringify(rows),JSON.stringify(history.transactions),JSON.stringify(accounting.entries),JSON.stringify(credits)])
  const result=recorded[0]?.result as Row
  if(!result||!['CHECKPOINT_COMMITTED','DEFERRED_EXISTING_GUARDS_RETAINED'].includes(String(result.status)))throw Error('CHECKPOINT_PUBLICATION_RESPONSE')
  return{...result,transactions:(history.transactions as Row[]).length}
 }catch(e){
  if(e&&typeof e==='object'&&'code' in e)throw e
  const reason=e instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:'CHECKPOINT_PUBLICATION_FAILED'
  console.warn('[R36 HISTORY CHECKPOINT]',{status:'DEFERRED_EXISTING_GUARDS_RETAINED',reason})
  return{status:'DEFERRED_EXISTING_GUARDS_RETAINED',reason}
 }
}
