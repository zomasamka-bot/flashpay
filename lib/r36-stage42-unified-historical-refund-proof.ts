/** Stage42 Phase1G — conservative historical refund preflight. READ ONLY, NO CERTIFICATE.
 * Historical wallet binding cannot be inferred from current authority.
 * One PostgreSQL MVCC snapshot; independent Horizon validation happens after rollback.
 */
import { verifyR36IndependentHorizonRecord, type R36HorizonProofInput, type R36HorizonRecord } from './r36-independent-horizon-proof'
export type Db = {query:(sql:string,params?:readonly unknown[])=>Promise<{rows:Record<string,unknown>[]}>;release:()=>void}
export type Pool = {connect:()=>Promise<Db>}
export type Outcome = Readonly<{outcome:'BLOCKED';reason:string;authorizesRotation:false;refundsInspected:number}>
const deny=(reason:string,refundsInspected=0):Outcome=>({outcome:'BLOCKED',reason,authorizesRotation:false,refundsInspected})
const WALLET=/^G[A-Z2-7]{55}$/
/** The provider is a READ-ONLY, externally sourced transaction record lookup, not an assertion of success. */
export async function inspectHistoricalRefunds(pool:Pool,sourceWallet:string,readHorizon:(hash:string)=>Promise<R36HorizonRecord|null>):Promise<Outcome>{
 if(!WALLET.test(sourceWallet))return deny('INVALID_SOURCE_WALLET')
 let db:Db|undefined;let tx=false;let rows:Record<string,unknown>[]=[]
 try{
  db=await pool.connect()
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');tx=true
  // No authority join: current-owner records are not historical ownership evidence.
  const result=await db.query(`SELECT refund_id,payment_id,refund_txid,refund_payment_id,status,stage FROM refund_checkpoints ORDER BY refund_id`)
  if(!Array.isArray(result.rows))return deny('INVALID_SNAPSHOT_RESULT')
  rows=result.rows.map(x=>({...x}))
 }catch{return deny('POSTGRES_SNAPSHOT_FAILED')}
 finally{if(db){if(tx)try{await db.query('ROLLBACK')}catch{rows=[]}try{db.release()}catch{rows=[]}}}
 if(!rows.length)return deny('EMPTY_OR_FAILED_SNAPSHOT_NOT_A_CERTIFICATE')
 const ids=new Set<string>()
 for(const row of rows){
  if(typeof row.refund_id!=='string'||ids.has(row.refund_id))return deny('DUPLICATE_OR_INVALID_REFUND_ID',rows.length)
  ids.add(row.refund_id)
  if(row.status!=='completed'||typeof row.refund_txid!=='string'|| !/^[0-9a-f]{64}$/.test(row.refund_txid))return deny('UNRESOLVED_OR_INVALID_REFUND',rows.length)
 }
 // CRITICAL: Original checkpoint schema does not supply historical source wallet,
 // signed envelope, operation sequence, destination, amount and immutable owner
 // at every rotation. Do not call Horizon with an invented or current-owner binding.
 // A future implementation must load independently attested historical bindings
 // and accounting in this same snapshot, then validate exact XDR/Result XDR.
 void readHorizon;void verifyR36IndependentHorizonRecord
 return deny('HISTORICAL_SOURCE_XDR_AND_ACCOUNTING_BINDINGS_NOT_DURABLY_PROVEN',rows.length)
}
/** For a *separately attested* exact record only; this NEVER authorizes rotation. */
export function checkExactRefundHorizon(input:R36HorizonProofInput,record:R36HorizonRecord):Outcome{
 const proof=verifyR36IndependentHorizonRecord(input,record)
 return deny(proof.outcome==='PROVEN'?'EXACT_TRANSACTION_MATCH_HISTORY_AND_ACCOUNTING_UNPROVEN':`HORIZON_${proof.reason}`,1)
}
