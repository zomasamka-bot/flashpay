import {financialIncomingWallet} from './financial-network'
import {financialNetwork} from './financial-network'
/** NOT_FOR_DEPLOY. Full, deterministic review of independently signed artifact bodies.
 * Invoke only AFTER the worker authenticates each artifact against the protected policy.
 * This validates the supplied certified scope, never invents missing history or rights.
 * A provider's independently approved completeness attestation remains a trust input.
 */
import {createHash} from 'node:crypto'
import {Transaction,TransactionBuilder,xdr} from '@stellar/stellar-sdk'
import {verifyR36IndependentHorizonRecord} from './r36-independent-horizon-proof'

type Row=Record<string,unknown>
const object=(x:unknown):x is Row=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype
// SDK 17 decodes XDR unions as class instances, not JSON objects.
const decoded=(x:unknown):x is Row=>!!x&&typeof x==='object'&&!Array.isArray(x)
const decodedList=(x:unknown):x is Row[]=>Array.isArray(x)&&x.length===1&&x.every(decoded)
const hex=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x)
const uint=(x:unknown):x is string=>typeof x==='string'&&/^(0|[1-9][0-9]{0,29})$/.test(x)
const identifier=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x)
const wallet=(x:unknown):x is string=>typeof x==='string'&&/^G[A-Z2-7]{55}$/.test(x)
const list=(x:unknown):x is Row[]=>Array.isArray(x)&&x.length<=20000&&x.every(object)
export const r36SnapshotDigest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
function requireProof(ok:unknown,reason:string):asserts ok{if(!ok)throw Error(reason)}
function stroops(v:unknown):bigint{requireProof(typeof v==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{1,7})?$/.test(v),'INVALID_AMOUNT');const [a,b='']=v.split('.');return BigInt(a)*BigInt(10000000)+BigInt(b.padEnd(7,'0'))}
export type R36SnapshotReview={outcome:'VERIFIED_SNAPSHOT'|'BLOCKED';reason:string;reviewDigest?:string;transactions?:number;accountingEntries?:number;isolatedExceptions?:number;authorizesFinancialRelease:false}
function reviewWallet(binding:Row,artifacts:Record<string,Row>,bindIntent:boolean):R36SnapshotReview{
 try{
  const h=artifacts.wallet_history,a=artifacts.accounting,x=artifacts.exceptions,s=artifacts.exception_isolation
  requireProof(object(h)&&object(a)&&object(x)&&object(s)&&object(h.snapshot)&&object(a.snapshot),'FULL_SNAPSHOT_REQUIRED')
  const history=h.snapshot,accounting=a.snapshot
  requireProof(h.schema==='R36_COMPLETE_HISTORY_V1'&&a.schema==='R36_ACCOUNTING_CLEARANCE_V1'&&a.unbalancedStroops==='0'&&Array.isArray(a.duplicateFinancialKeys)&&a.duplicateFinancialKeys.length===0&&Array.isArray(a.xorViolations)&&a.xorViolations.length===0&&x.schema==='R36_HISTORICAL_EXCEPTIONS_V1'&&s.schema==='R36_EXCEPTION_ISOLATION_V1'&&s.disposition==='ISOLATED_NO_CURRENT_RIGHTS_IMPACT'&&s.currentRightsDigest===a.currentRightsDigest,'WALLET_CLEARANCE_CONTRACT')
  requireProof(history.schema==='R36_COMPLETE_WALLET_SNAPSHOT_V1'&&accounting.schema==='R36_ACCOUNTING_SNAPSHOT_V1','SNAPSHOT_SCHEMA')
  requireProof(history.network===binding.network&&history.wallet===binding.sourceWallet&&history.cutoffLedger===binding.cutoffLedger&&history.cutoffHash===h.cutoffHash&&wallet(history.wallet),'SNAPSHOT_SCOPE')
  requireProof(uint(history.cutoffLedger)&&list(history.walletInventory)&&history.walletInventory.length>0&&list(history.transactions)&&object(history.genesis)&&list(accounting.entries)&&list(accounting.merchantBalances)&&list(accounting.openObligations)&&list(x.records)&&list(s.records),'SNAPSHOT_ROWS')
  const inventory=new Set<string>()
  for(const w of history.walletInventory){requireProof(wallet(w.wallet)&&uint(w.firstLedger)&&uint(w.lastLedger)&&BigInt(w.lastLedger)>=BigInt(w.firstLedger)&&!inventory.has(w.wallet),'WALLET_INVENTORY_INVALID');inventory.add(w.wallet)}
  requireProof(inventory.has(history.wallet)&&h.controlledWalletsInventoryDigest===r36SnapshotDigest(history.walletInventory),'WALLET_INVENTORY_DIGEST')
  const range=history.walletInventory.find(w=>w.wallet===history.wallet)!
  requireProof(range.firstLedger===h.genesisLedger&&range.lastLedger===history.cutoffLedger,'WALLET_INVENTORY_RANGE')
  const genesis=history.genesis
  requireProof(genesis.ledger===h.genesisLedger&&uint(genesis.ledger)&&Number.isSafeInteger(Number(genesis.ledger))&&Number(genesis.ledger)>0&&hex(genesis.hash)&&typeof genesis.envelopeXdr==='string'&&typeof genesis.resultXdr==='string'&&uint(genesis.feeStroops),'GENESIS_REQUIRED')
  const created=TransactionBuilder.fromXDR(genesis.envelopeXdr,financialNetwork())
  requireProof(created instanceof Transaction&&created.toXDR()===genesis.envelopeXdr&&Buffer.from(created.hash()).toString('hex')===genesis.hash&&created.operations.length===1,'GENESIS_XDR')
  const creation=created.operations[0]
  requireProof(creation.type==='createAccount'&&creation.destination===history.wallet&&created.source!==history.wallet,'GENESIS_OPERATION')
  if(creation.source!==undefined){
   // The fee payer and funder may differ in an original Pi faucet transaction.
   // Accept only with both original Horizon records bound to this exact XDR.
   const r=genesis.sourceRecord,o=genesis.operationRecord
   requireProof(wallet(creation.source)&&creation.source!==history.wallet&&object(r)&&object(o),'GENESIS_FUNDER_EVIDENCE_REQUIRED')
   requireProof(r.hash===genesis.hash&&r.successful===true&&String(r.ledger)===genesis.ledger&&r.source_account===created.source&&String(r.source_account_sequence)===created.sequence&&r.envelope_xdr===genesis.envelopeXdr&&r.result_xdr===genesis.resultXdr&&String(r.fee_charged)===genesis.feeStroops,'GENESIS_TRANSACTION_BINDING')
   requireProof(uint(o.id)&&BigInt(o.id)/BigInt(4294967296)===BigInt(genesis.ledger)&&o.type==='create_account'&&o.transaction_hash===genesis.hash&&o.transaction_successful===true&&o.source_account===creation.source&&o.funder===creation.source&&o.account===history.wallet&&stroops(o.starting_balance)===stroops(creation.startingBalance),'GENESIS_FUNDER_BINDING')
  }
  const gr=xdr.TransactionResult.fromXDR(genesis.resultXdr,'base64')
  const gres=gr.result as unknown as Row
  requireProof(gr.toXDR('base64')===genesis.resultXdr&&gr.feeCharged.toString()===genesis.feeStroops&&gres.type==='txSuccess'&&decodedList(gres.results)&&gres.results.length===1,'GENESIS_RESULT')
  const go=gres.results[0];requireProof(go.type==='opInner'&&decoded(go.tr)&&go.tr.type==='createAccount'&&decoded(go.tr.createAccountResult)&&go.tr.createAccountResult.type==='createAccountSuccess','GENESIS_RESULT_OPERATION')
  let balance=stroops(creation.startingBalance),sequence=BigInt(genesis.ledger)*BigInt(4294967296),lastLedger=BigInt(genesis.ledger)
  const seen=new Set<string>(),opIds=new Set<string>(),outgoing=new Map<string,{hash:string;amount:string;fee:string;destination:string;successful:boolean}>()
  for(const t of history.transactions){
   requireProof(object(t.input)&&object(t.record)&&uint(t.operationId)&&t.operationId!=='0','TRANSACTION_SHAPE')
   const i=t.input,r=t.record
   requireProof(i.network===financialNetwork()&&hex(i.preparedHash)&&typeof i.envelopeXdr==='string'&&uint(i.preparedSequence)&&wallet(i.sourceWallet)&&wallet(i.destinationWallet)&&uint(i.expectedFeeStroops),'TRANSACTION_INPUT')
   requireProof(!seen.has(i.preparedHash)&&!opIds.has(t.operationId),'DUPLICATE_NETWORK_RECORD');seen.add(i.preparedHash);opIds.add(t.operationId)
   const ledger=String(r.ledger)
   requireProof(uint(ledger)&&BigInt(ledger)>=lastLedger&&BigInt(ledger)<=BigInt(history.cutoffLedger),'TRANSACTION_LEDGER_ORDER');lastLedger=BigInt(ledger)
   // Horizon operation ID: high 32 bits identify the containing ledger.
   requireProof(BigInt(t.operationId)/BigInt(4294967296)===BigInt(ledger),'OPERATION_LEDGER_MISMATCH')
   requireProof(i.sourceWallet===history.wallet||i.destinationWallet===history.wallet,'FOREIGN_WALLET_RECORD')
   const parsed=TransactionBuilder.fromXDR(i.envelopeXdr,financialNetwork())
   requireProof(parsed instanceof Transaction&&parsed.toXDR()===i.envelopeXdr&&Buffer.from(parsed.hash()).toString('hex')===i.preparedHash&&parsed.source===i.sourceWallet&&parsed.sequence===i.preparedSequence&&parsed.operations.length===1,'HISTORY_XDR_IDENTITY')
   const op=parsed.operations[0]
   requireProof(op.type==='payment'&&op.source===undefined&&op.asset.isNative()&&op.destination===i.destinationWallet&&stroops(op.amount)===stroops(i.amount),'HISTORY_OPERATION')
   requireProof(r.hash===i.preparedHash&&r.source_account===i.sourceWallet&&String(r.source_account_sequence)===i.preparedSequence&&r.envelope_xdr===i.envelopeXdr&&String(r.fee_charged)===i.expectedFeeStroops&&typeof r.result_xdr==='string','HISTORY_RECORD_IDENTITY')
   if(i.sourceWallet===history.wallet){requireProof(BigInt(i.preparedSequence)===sequence+BigInt(1),'OUTBOUND_SEQUENCE_GAP');sequence++;balance-=BigInt(i.expectedFeeStroops)}
   if(r.successful===true){
    const result=verifyR36IndependentHorizonRecord(i as Parameters<typeof verifyR36IndependentHorizonRecord>[0],r)
    requireProof(result.outcome==='PROVEN','HISTORY_RESULT_NOT_PROVEN')
    const amount=stroops(i.amount);requireProof(amount>BigInt(0),'HISTORY_NONPOSITIVE_PAYMENT')
    if(i.sourceWallet===history.wallet){balance-=amount;outgoing.set(t.operationId,{hash:i.preparedHash,amount:amount.toString(),fee:i.expectedFeeStroops,destination:i.destinationWallet,successful:true})}if(i.destinationWallet===history.wallet)balance+=amount
   }else{
    requireProof(r.successful===false,'HISTORY_SUCCESS_REQUIRED')
    const failed=xdr.TransactionResult.fromXDR(r.result_xdr,'base64'),fr=failed.result as unknown as Row
    requireProof(failed.toXDR('base64')===r.result_xdr&&failed.feeCharged.toString()===i.expectedFeeStroops&&fr.type==='txFailed'&&decodedList(fr.results)&&fr.results.length===1,'FAILED_TRANSACTION_RESULT')
    const fo=fr.results[0]
    requireProof(fo.type!=='opInner'||decoded(fo.tr)&&fo.tr.type==='payment'&&decoded(fo.tr.paymentResult)&&fo.tr.paymentResult.type!=='paymentSuccess','FAILED_OPERATION_RESULT')
    if(i.sourceWallet===history.wallet)outgoing.set(t.operationId,{hash:i.preparedHash,amount:'0',fee:i.expectedFeeStroops,destination:i.destinationWallet,successful:false})
   }
   requireProof(balance>=BigInt(0),'NEGATIVE_HISTORY_BALANCE')
  }
  if(bindIntent)requireProof((financialIncomingWallet()!==binding.sourceWallet||seen.has(String(binding.u2aTxid)))&&!seen.has(String(binding.preparedHash))&&uint(binding.preparedSequence)&&BigInt(binding.preparedSequence)===sequence+BigInt(1),'PREPARED_OR_INBOUND_HISTORY_BINDING')
  if(bindIntent){
   const incoming=financialIncomingWallet()===binding.sourceWallet?history:(artifacts.wallet_history.relatedWallets as Row[]|undefined)?.find(h=>h.sourceWallet===financialIncomingWallet())?.snapshot as Row|undefined
   requireProof(object(incoming)&&Array.isArray(incoming.transactions),'INCOMING_WALLET_HISTORY_REQUIRED')
   const finality=artifacts.inbound_finality,intent=artifacts.intent,t=(incoming.transactions as Row[]).find(t=>object(t.input)&&t.input.preparedHash===binding.u2aTxid)
   requireProof(object(finality)&&object(finality.horizonInput)&&object(finality.horizonRecord)&&t&&object(t.input)&&object(t.record)&&t.record.successful===true,'INBOUND_HISTORY_FINALITY_MISSING')
   for(const field of ['hash','successful','ledger','fee_charged','source_account','source_account_sequence','envelope_xdr','result_xdr'])requireProof(String(t.record[field])===String(finality.horizonRecord[field]),'INBOUND_HISTORY_FINALITY_CONFLICT')
   for(const field of ['network','preparedHash','preparedSequence','sourceWallet','destinationWallet','envelopeXdr','expectedFeeStroops'])requireProof(String(t.input[field])===String(finality.horizonInput[field]),'INBOUND_HISTORY_IDENTITY_CONFLICT')
   requireProof(stroops(t.input.amount)===stroops(finality.horizonInput.amount)&&object(intent)&&typeof intent.envelopeXdr==='string'&&uint(binding.amountStroops),'INBOUND_HISTORY_AMOUNT_CONFLICT')
   const prepared=TransactionBuilder.fromXDR(intent.envelopeXdr,financialNetwork())
   requireProof(prepared instanceof Transaction&&uint(prepared.fee)&&BigInt(binding.amountStroops)+BigInt(prepared.fee)<=balance,'PREPARED_EXCEEDS_PROVEN_BALANCE')
  }
  requireProof(uint(history.closingBalanceStroops)&&BigInt(history.closingBalanceStroops)===balance&&uint(history.closingSequence)&&BigInt(history.closingSequence)===sequence,'CLOSING_ACCOUNT_MISMATCH')
  requireProof(h.transactionsDigest===r36SnapshotDigest(history.transactions)&&h.operationsDigest===r36SnapshotDigest([...opIds]),'HISTORY_INVENTORY_DIGEST')
  requireProof(object(history.coverage)&&history.coverage.schema==='R36_PROVIDER_CUTOFF_ATTESTATION_V1'&&identifier(history.coverage.sourceId)&&history.coverage.genesisHash===genesis.hash&&history.coverage.cutoffLedger===history.cutoffLedger&&history.coverage.cutoffHash===history.cutoffHash&&history.coverage.transactionsDigest===h.transactionsDigest&&h.continuityProofDigest===r36SnapshotDigest(history.coverage),'SIGNED_COVERAGE_BINDING')
  // Each accounting entry is matched bijectively to one independently verified outflow.
  const operationKeys=new Set<string>(),entryIds=new Set<string>(),paymentIds=new Set<string>(),receiptIds=new Set<string>(),accountedOps=new Set<string>(),credits=new Map<string,bigint>()
  for(const e of accounting.entries){
   requireProof(identifier(e.entryId)&&identifier(e.paymentId)&&identifier(e.operationId)&&uint(e.horizonOperationId)&&hex(e.transactionHash)&&uint(e.amountStroops)&&uint(e.feeStroops)&&wallet(e.destinationWallet)&&['settlement','refund'].includes(String(e.kind)),'ACCOUNTING_ENTRY_SHAPE')
   requireProof(!operationKeys.has(e.kind+':'+e.operationId)&&!entryIds.has(e.entryId)&&!paymentIds.has(e.paymentId)&&!accountedOps.has(e.horizonOperationId),'DUPLICATE_OR_XOR_ACCOUNTING');operationKeys.add(e.kind+':'+e.operationId);entryIds.add(e.entryId);paymentIds.add(e.paymentId);accountedOps.add(e.horizonOperationId)
   const n=outgoing.get(e.horizonOperationId)
   requireProof(n&&n.successful&&n.hash===e.transactionHash&&n.amount===e.amountStroops&&n.fee===e.feeStroops&&n.destination===e.destinationWallet,'ACCOUNTING_NETWORK_MISMATCH')
   if(e.kind==='settlement'){
    requireProof(e.stage==='db_finalized'&&identifier(e.receiptId)&&identifier(e.merchantUid)&&!receiptIds.has(e.receiptId),'SETTLEMENT_RECEIPT');receiptIds.add(e.receiptId);credits.set(e.merchantUid,(credits.get(e.merchantUid)??BigInt(0))+BigInt(e.amountStroops))
   }else requireProof(e.stage==='completed'&&e.receiptId===null&&e.merchantUid===null&&e.refundId===e.operationId,'REFUND_ACCOUNTING')
  }
  const merchants=new Set<string>()
  for(const b of accounting.merchantBalances){requireProof(identifier(b.merchantUid)&&uint(b.creditStroops)&&!merchants.has(b.merchantUid)&&BigInt(b.creditStroops)===(credits.get(b.merchantUid)??BigInt(0)),'MERCHANT_BALANCE_MISMATCH');merchants.add(b.merchantUid)}
  requireProof([...credits.keys()].every(k=>merchants.has(k)),'MERCHANT_BALANCE_MISSING')
  const exceptionIds=new Set<string>(),isolatedOps=new Set<string>()
  for(const e of x.records){
   requireProof(identifier(e.id)&&!exceptionIds.has(e.id)&&hex(e.originalRecordDigest)&&Array.isArray(e.operationIds)&&Array.isArray(e.affectedPaymentIds)&&e.affectedPaymentIds.every(identifier),'EXCEPTION_RECORD');exceptionIds.add(e.id)
   requireProof(['completed','retired_with_terminal_evidence','reconciled'].includes(String(e.status)),'UNRESOLVED_EXCEPTION_CANNOT_BE_ISOLATED')
   const isolates=s.records.filter(t=>t.id===e.id);requireProof(isolates.length===1,'EXCEPTION_ISOLATION_CARDINALITY');const proof=isolates[0]
   requireProof(proof.originalRecordDigest===e.originalRecordDigest&&hex(proof.dispositionEvidenceDigest)&&proof.currentRightsDigest===a.currentRightsDigest&&proof.disposition==='ISOLATED_NO_CURRENT_RIGHTS_IMPACT'&&JSON.stringify(proof.operationIds)===JSON.stringify(e.operationIds),'EXCEPTION_ISOLATION_BINDING')
   requireProof(!accounting.openObligations.some(o=>o.exceptionId===e.id||e.affectedPaymentIds instanceof Array&&e.affectedPaymentIds.includes(o.paymentId)),'EXCEPTION_HAS_CURRENT_RIGHTS')
   for(const op of e.operationIds){requireProof(typeof op==='string'&&outgoing.has(op)&&!accountedOps.has(op)&&!isolatedOps.has(op),'EXCEPTION_MOVEMENT_OVERLAP');isolatedOps.add(op)}
  }
  requireProof(s.records.length===exceptionIds.size&&JSON.stringify([...exceptionIds].sort())===JSON.stringify(x.ids)&&JSON.stringify(x.ids)===JSON.stringify(s.exceptionIds),'EXCEPTION_INVENTORY')
  requireProof(accountedOps.size+isolatedOps.size===outgoing.size,'UNCLASSIFIED_OUTBOUND')
  // Unknown wallet bindings remain global blockers, matching the original SQL contract.
  requireProof(accounting.openObligations.every(o=>wallet(o.sourceWallet)&&o.sourceWallet!==history.wallet&&hex(o.originalBindingDigest)&&o.disposition==='PROVED_OTHER_WALLET'),'OPEN_OR_UNSCOPED_CURRENT_OBLIGATION')
  requireProof(a.pgSnapshotDigest===r36SnapshotDigest(accounting)&&a.currentRightsDigest===r36SnapshotDigest(accounting.openObligations)&&x.recordsDigest===r36SnapshotDigest(x.records)&&s.evidenceDigest===r36SnapshotDigest(s.records),'SNAPSHOT_ACCOUNTING_DIGEST')
  const reviewDigest=r36SnapshotDigest({history:h.transactionsDigest,accounting:a.pgSnapshotDigest,exceptions:x.recordsDigest,isolation:s.evidenceDigest,scope:[binding.network,binding.sourceWallet,binding.cutoffLedger]})
  requireProof(a.reconciliationDigest===reviewDigest,'RECONCILIATION_DIGEST')
  return{outcome:'VERIFIED_SNAPSHOT',reason:'SIGNED_SCOPE_EXACT_HISTORY_ACCOUNTING_AND_ISOLATION',reviewDigest,transactions:seen.size,accountingEntries:entryIds.size,isolatedExceptions:exceptionIds.size,authorizesFinancialRelease:false}
 }catch(e){return{outcome:'BLOCKED',reason:e instanceof Error?e.message:'SNAPSHOT_REVIEW_FAILED',authorizesFinancialRelease:false}}
}

/** Every wallet in the independently attested inventory needs its own full history,
 * accounting and exception-isolation bodies. Extra/missing scopes fail closed.
 * All four collections are covered by their corresponding authenticated artifacts;
 * the caller cannot satisfy coverage by listing a wallet or a digest alone. */
export function reviewR36EvidenceSnapshot(binding:Row,artifacts:Record<string,Row>):R36SnapshotReview{
 return reviewAllWalletSnapshots(binding,artifacts,true)
}

/** Initial scope only: an original funded account with no later movements.
 * This is not transaction admission, financial clearance or wallet activation. */
export function reviewR36WalletBootstrapSnapshot(binding:Row,artifacts:Record<string,Row>):R36SnapshotReview{
 const h=artifacts.wallet_history?.snapshot,a=artifacts.accounting?.snapshot
 if(!object(h)||!object(a)||!Array.isArray(h.transactions)||h.transactions.length!==0||!Array.isArray(h.walletInventory)||h.walletInventory.length!==1||!Array.isArray(a.entries)||a.entries.length!==0||!Array.isArray(a.openObligations)||a.openObligations.length!==0)return {outcome:'BLOCKED',reason:'BOOTSTRAP_MUST_HAVE_NO_PRIOR_MOVEMENTS',authorizesFinancialRelease:false}
 return reviewAllWalletSnapshots(binding,artifacts,false)
}

function reviewAllWalletSnapshots(binding:Row,artifacts:Record<string,Row>,bindIntent:boolean):R36SnapshotReview{
 try{
  const primary=reviewWallet(binding,artifacts,bindIntent);if(primary.outcome!=='VERIFIED_SNAPSHOT')return primary
  const h=artifacts.wallet_history,inventory=(h.snapshot as Row).walletInventory as Row[]
  const others=inventory.filter(w=>w.wallet!==binding.sourceWallet),kinds=['wallet_history','accounting','exceptions','exception_isolation']
  const grouped:Record<string,Row[]>={}
  for(const kind of kinds){const rows=artifacts[kind].relatedWallets??[];requireProof(list(rows)&&rows.length===others.length,'RELATED_WALLET_COVERAGE_REQUIRED');grouped[kind]=rows}
  const reviewed=[primary],operations=new Set<string>(),payments=new Set<string>(),entries=new Set<string>(),receipts=new Set<string>()
  const uniqueAccounting=(a:Row)=>{for(const e of (a.snapshot as Row).entries as Row[]){requireProof(!operations.has(String(e.kind)+':'+String(e.operationId))&&!payments.has(String(e.paymentId))&&!entries.has(String(e.entryId))&&(e.receiptId===null||!receipts.has(String(e.receiptId))),'CROSS_WALLET_DUPLICATE_OR_XOR');operations.add(String(e.kind)+':'+String(e.operationId));payments.add(String(e.paymentId));entries.add(String(e.entryId));if(e.receiptId!==null)receipts.add(String(e.receiptId))}}
  uniqueAccounting(artifacts.accounting)
  for(const wallet of others){
   const related:Record<string,Row>={}
   for(const kind of kinds){const matches=grouped[kind].filter(r=>r.sourceWallet===wallet.wallet&&r.network===binding.network&&r.cutoffLedger===wallet.lastLedger);requireProof(matches.length===1,'RELATED_WALLET_SCOPE_CARDINALITY');related[kind]=matches[0]}
   requireProof(object(related.wallet_history.snapshot)&&JSON.stringify(related.wallet_history.snapshot.walletInventory)===JSON.stringify(inventory),'RELATED_WALLET_INVENTORY_MISMATCH')
   const review=reviewWallet({network:binding.network,sourceWallet:wallet.wallet,cutoffLedger:wallet.lastLedger},related,false)
   requireProof(review.outcome==='VERIFIED_SNAPSHOT','RELATED_'+review.reason);reviewed.push(review);uniqueAccounting(related.accounting)
  }
  return{outcome:'VERIFIED_SNAPSHOT',reason:'ALL_ATTESTED_WALLET_SCOPES_REVIEWED',reviewDigest:r36SnapshotDigest(reviewed.map(r=>r.reviewDigest)),transactions:reviewed.reduce((n,r)=>n+(r.transactions??0),0),accountingEntries:reviewed.reduce((n,r)=>n+(r.accountingEntries??0),0),isolatedExceptions:reviewed.reduce((n,r)=>n+(r.isolatedExceptions??0),0),authorizesFinancialRelease:false}
 }catch(e){return{outcome:'BLOCKED',reason:e instanceof Error?e.message:'WALLET_SCOPE_REVIEW_FAILED',authorizesFinancialRelease:false}}
}

/** Terminal review is a separate purpose: it requires the completed outflow to be
 * present and accounted, rather than treating it as a not-yet-submitted intent.
 * It never authorizes a successor. Every wallet/snapshot/XOR/isolation check above
 * still applies, including unresolved global obligations.
 */
export function reviewR36TerminalSnapshot(binding:Row,artifacts:Record<string,Row>):R36SnapshotReview{
 try{
  const result=reviewAllWalletSnapshots(binding,artifacts,false)
  if(result.outcome!=='VERIFIED_SNAPSHOT')return result
  const history=artifacts.wallet_history.snapshot as Row,accounting=artifacts.accounting.snapshot as Row
  requireProof(uint(binding.preparedSequence)&&history.closingSequence===binding.preparedSequence,'TERMINAL_WALLET_SEQUENCE')
  const txs=(history.transactions as Row[]).filter(t=>object(t.input)&&t.input.preparedHash===binding.preparedHash)
  requireProof(txs.length===1&&object(txs[0].input)&&object(txs[0].record),'TERMINAL_OUTFLOW_MISSING')
  const t=txs[0],i=t.input as Row,r=t.record as Row
  requireProof(i.sourceWallet===binding.sourceWallet&&i.preparedSequence===binding.preparedSequence&&r.successful===true&&
   stroops(i.amount).toString()===binding.amountStroops&&i.expectedFeeStroops===binding.feeStroops,'TERMINAL_OUTFLOW_MISMATCH')
  const entries=(accounting.entries as Row[]).filter(e=>e.paymentId===binding.paymentId)
  requireProof(entries.length===1&&entries[0].operationId===binding.operationId&&entries[0].kind===binding.operationKind&&
   entries[0].transactionHash===binding.preparedHash&&entries[0].horizonOperationId===t.operationId&&
   entries[0].amountStroops===binding.amountStroops&&entries[0].destinationWallet===i.destinationWallet&&
   entries[0].receiptId===binding.receiptId&&entries[0].entryId===binding.entryId,'TERMINAL_ACCOUNTING_IDENTITY')
  return {...result,reason:'COMPLETE_TERMINAL_HISTORY_AND_ACCOUNTING_NO_SUCCESSOR_AUTHORITY'}
 }catch(e){return{outcome:'BLOCKED',reason:e instanceof Error?e.message:'TERMINAL_REVIEW_FAILED',authorizesFinancialRelease:false}}
}
