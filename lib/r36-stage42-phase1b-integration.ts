/** Read-only diagnostic integration. NEVER certification or rotation authority. */
import {readR36HorizonHistoryCandidate} from './r36-horizon-history-reader'
import {compareR36WalletHistoryAccounting} from './r36-wallet-history-accounting-audit'
export type QueryClient={query:(sql:string,params?:readonly unknown[])=>Promise<{rows:Record<string,unknown>[]}>}
export type Phase1B=Readonly<{outcome:'BLOCKED';reason:string;authorizesRotation:false;horizonReason:string;databaseReason:string;observedOperations:number;durableSettlements:number;durableRefunds:number;accountingRows:number}>
export async function diagnoseR36Phase1B(input:{walletId:string;upperLedger:number;pg:QueryClient;fetcher?:typeof fetch}):Promise<Phase1B>{
 let hReason='NOT_READ',dbReason='NOT_READ',observedOperations=0,durableSettlements=0,durableRefunds=0,accountingRows=0
 const result=(reason:string):Phase1B=>({outcome:'BLOCKED',reason,authorizesRotation:false,horizonReason:hReason,databaseReason:dbReason,observedOperations,durableSettlements,durableRefunds,accountingRows})
 if(!/^G[A-Z2-7]{55}$/.test(input.walletId)||!Number.isSafeInteger(input.upperLedger)||input.upperLedger<1)return result('INVALID_INPUT')
 // Transaction-level consistent read-only snapshot. Never derive authority from it.
 let started=false
 try{
  await input.pg.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');started=true
  const s=await input.pg.query(`SELECT payment_id,stage,a2u_from_address,a2u_to_address,prepared_tx_hash,prepared_sequence,a2u_txid,merchant_amount,db_finalized_at FROM settlement_checkpoints WHERE a2u_from_address = $1 ORDER BY payment_id`,[input.walletId])
  const r=await input.pg.query(`SELECT refund_id,payment_id,status,stage,refund_txid,amount FROM refund_checkpoints ORDER BY payment_id`)
  const a=await input.pg.query(`SELECT t.payment_id,t.id AS transaction_id,t.amount AS transaction_amount,r.id AS receipt_id,r.a2u_txid,r.merchant_amount,r.settlement_status FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id ORDER BY t.payment_id`)
  durableSettlements=s.rows.length;durableRefunds=r.rows.length;accountingRows=a.rows.length
  // Explicitly identify unresolved and unscoped records. Refund source wallet is not
  // present in this schema: a complete wallet-level refund inventory is unavailable.
  const pending=s.rows.filter(x=>x.stage!=='db_finalized').length
  const invalid=s.rows.filter(x=>x.stage==='db_finalized'&&(!x.db_finalized_at||!x.a2u_txid||!x.prepared_tx_hash||x.a2u_txid!==x.prepared_tx_hash)).length
  const missingAccounting=s.rows.filter(x=>x.stage==='db_finalized'&&!a.rows.some(y=>y.payment_id===x.payment_id&&y.receipt_id&&y.a2u_txid===x.a2u_txid)).length
  dbReason=invalid?'INVALID_FINALITY_FIELDS':missingAccounting?'MISSING_FINAL_ACCOUNTING':pending?'PENDING_SETTLEMENT':r.rows.length?'REFUND_WALLET_PROVENANCE_UNAVAILABLE':'REFUND_WALLET_PROVENANCE_UNAVAILABLE'
  await input.pg.query('COMMIT');started=false
 }catch(e){dbReason='SNAPSHOT_FAILED';if(started)try{await input.pg.query('ROLLBACK')}catch{};return result('POSTGRES_SNAPSHOT_FAILED')}
 const h=await readR36HorizonHistoryCandidate({walletId:input.walletId,upperLedger:input.upperLedger,fetcher:input.fetcher,maxPages:1000})
 hReason=h.reason;observedOperations=h.records
 // The original Horizon reader does not prove account creation, upper ledger finality,
 // or operation completeness. Its records also lack authenticated transaction sequence
 // and application payment ID required by the comparator. Do not fabricate mappings.
 return result('HISTORY_COMPLETENESS_AND_DURABLE_PROVENANCE_NOT_CERTIFIED')
}
