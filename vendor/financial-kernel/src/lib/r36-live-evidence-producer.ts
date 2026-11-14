import {readR36ReadonlyEnvelope} from './r36-readonly-envelope'
import {encodeR36Artifact} from './r36-artifact-codec'
import {financialContractFromRow,netImpact} from './payment-financial-contract'
import {financialIncomingWallet} from './financial-network'
import {type FinancialNetwork,financialNetwork} from './financial-network'
/** Unsigned evidence production from original read-only records. This is NOT an
 * issuer, finality oracle or history-completeness certificate. Independently
 * enrolled custodians must establish scope/custody before signing any output.
 * Unknown historical rights are blockers, never fabricated exception dispositions.
 */
import {Transaction,TransactionBuilder} from '@stellar/stellar-sdk'
import {createHash} from 'node:crypto'
import {R36_ADMISSION_FIELDS} from './r36-certificate-consumer'
import {r36SnapshotDigest,reviewR36EvidenceSnapshot} from './r36-evidence-snapshot'
import {numberToExactPositiveStroops} from './financial-amount-stroops'
import type {R36LiveSnapshot,R36SourceRow as Row} from './r36-live-source'
import {scopeR36LiveSnapshot} from './r36-wallet-execution-scope'
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)
const wallet=(v:unknown):v is string=>typeof v==='string'&&/^G[A-Z2-7]{55}$/.test(v)
const uint=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,29})$/.test(v)
const hash=r36SnapshotDigest
function requireFact(v:unknown,why:string):asserts v{if(!v)throw Error(why)}
function amount(v:unknown):string{
 if(typeof v==='number'){const n=numberToExactPositiveStroops(v);requireFact(n!==null,'AMOUNT_PRECISION');return String(n)}
 requireFact(typeof v==='string'&&/^(0|[1-9][0-9]{0,29})(\.[0-9]{1,18})?$/.test(v),'AMOUNT_PRECISION')
 const [a,b='']=v.split('.');requireFact(/^0*$/.test(b.slice(7)),'AMOUNT_PRECISION')
 return String(BigInt(a)*BigInt(10000000)+BigInt(b.slice(0,7).padEnd(7,'0')))
}
function one(rows:Row[],predicate:(v:Row)=>boolean,why:string):Row{const found=rows.filter(predicate);requireFact(found.length===1,why);return found[0]}
function indexRows(rows:Row[],key:(r:Row)=>unknown):Map<unknown,Row[]>{const index=new Map<unknown,Row[]>();for(const row of rows){const k=key(row),group=index.get(k);if(group)group.push(row);else index.set(k,[row])}return index}
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v))
export type R36ObservedHistory={network:FinancialNetwork;wallet:string;cutoffLedger:string;cutoffHash:string;
 sourceId:string;walletInventory:Row[];transactions:Row[];operations:Row[];accountAtCutoff:Row}
/** All records are original observations (retained prefix plus a bounded delta).
 * Empty pagination and successful arithmetic do not establish independent coverage.
 */
export function normalizeR36ObservedHistory(input:R36ObservedHistory):Row{
 const h=input
 requireFact(h.network===financialNetwork()&&wallet(h.wallet)&&uint(h.cutoffLedger)&&hex(h.cutoffHash)&&
  /^[A-Za-z0-9_.:-]{1,128}$/.test(h.sourceId)&&Array.isArray(h.transactions)&&h.transactions.length>0&&h.transactions.length<=40001&&
  Array.isArray(h.operations)&&h.operations.length===h.transactions.length,'HISTORY_SOURCE_SCOPE')
 const first=h.transactions[0],g=readR36ReadonlyEnvelope(String(first.envelope_xdr),financialNetwork())
 requireFact(g.isTransaction&&g.operations.length===1&&g.operations[0].type==='createAccount'&&g.operations[0].destination===h.wallet&&first.successful===true,'ORIGINAL_GENESIS_REQUIRED')
 const genesis:Row={ledger:String(first.ledger),hash:first.hash,envelopeXdr:first.envelope_xdr,resultXdr:first.result_xdr,feeStroops:String(first.fee_charged)}
 requireFact(g.canonical===first.envelope_xdr&&g.hash===first.hash,'GENESIS_IDENTITY')
 const creation=one(h.operations,o=>o.transaction_hash===first.hash&&o.type==='create_account'&&o.account===h.wallet,'GENESIS_OPERATION_CARDINALITY')
 // Pi's Testnet faucet can use a transaction fee payer distinct from the
 // create-account funder. Preserve both original records for the verifier.
 if(g.operations[0].source!==undefined){
  genesis.sourceRecord=Object.fromEntries(['hash','successful','ledger','source_account','source_account_sequence','envelope_xdr','result_xdr','fee_charged'].map(k=>[k,first[k]]))
  genesis.operationRecord=Object.fromEntries(['id','type','transaction_hash','transaction_successful','source_account','funder','account','starting_balance'].map(k=>[k,creation[k]]))
 }
 const transactions:Row[]=[],operationsByHash=indexRows(h.operations,o=>o.transaction_hash)
 for(const r of h.transactions.slice(1)){
  const t=readR36ReadonlyEnvelope(String(r.envelope_xdr),financialNetwork())
  requireFact(t.isTransaction&&t.operations.length===1&&t.operations[0].type==='payment'&&t.operations[0].nativeAsset&&t.operations[0].source===undefined,'UNSUPPORTED_HISTORY_OPERATION')
  const op=t.operations[0],o=one(operationsByHash.get(r.hash)??[],v=>v.transaction_hash===r.hash,'NETWORK_OPERATION_CARDINALITY')
  requireFact(o.type==='payment'&&o.from===t.source&&o.to===op.destination&&amount(o.amount)===amount(op.amount)&&o.asset_type==='native','NETWORK_OPERATION_IDENTITY')
  transactions.push({operationId:String(o.id),input:{network:h.network,preparedHash:r.hash,preparedSequence:t.sequence,sourceWallet:t.source,
   destinationWallet:op.destination,amount:op.amount,envelopeXdr:r.envelope_xdr,expectedFeeStroops:String(r.fee_charged)},
   record:Object.fromEntries(['hash','successful','ledger','fee_charged','source_account','source_account_sequence','envelope_xdr','result_xdr'].map(k=>[k,r[k]]))})
 }
 requireFact(h.accountAtCutoff.account_id===h.wallet&&uint(String(h.accountAtCutoff.sequence))&&Array.isArray(h.accountAtCutoff.balances)&&
  uint(String(h.accountAtCutoff.last_modified_ledger))&&BigInt(String(h.accountAtCutoff.last_modified_ledger))<=BigInt(h.cutoffLedger),'ACCOUNT_SCOPE')
 const native=one(h.accountAtCutoff.balances as Row[],b=>b.asset_type==='native','NATIVE_BALANCE_REQUIRED')
 const snapshot:Row={schema:'R36_COMPLETE_WALLET_SNAPSHOT_V1',network:h.network,wallet:h.wallet,cutoffLedger:h.cutoffLedger,cutoffHash:h.cutoffHash,
  walletInventory:clone(h.walletInventory),genesis,transactions,closingBalanceStroops:amount(native.balance),closingSequence:String(h.accountAtCutoff.sequence)}
 snapshot.coverage={schema:'R36_PROVIDER_CUTOFF_ATTESTATION_V1',sourceId:h.sourceId,genesisHash:genesis.hash,cutoffLedger:h.cutoffLedger,cutoffHash:h.cutoffHash,transactionsDigest:hash(transactions)}
 return {schema:'R36_COMPLETE_HISTORY_V1',network:h.network,sourceWallet:h.wallet,cutoffLedger:h.cutoffLedger,genesisLedger:genesis.ledger,cutoffHash:h.cutoffHash,
  transactionsDigest:hash(transactions),operationsDigest:hash(transactions.map(t=>t.operationId)),controlledWalletsInventoryDigest:hash(h.walletInventory),continuityProofDigest:hash(snapshot.coverage),snapshot}
}
type Dispositions={records:Row[];isolation:Row[]}
type Input={snapshot:R36LiveSnapshot;histories:R36ObservedHistory[];paymentId:string;kind:'settlement'|'refund';nonce:string;
 sourceWallet:string;preparedEnvelopeXdr:string;inboundFinality:Row;outboundPi:Row;exceptions:Dispositions;executionScopeDigest?:string}
const flags={authorizesFinancialRelease:false,authorizesSubmission:false,authorizesWalletActivation:false,independentCertification:false} as const
export type R36ProducedEvidence={outcome:'UNSIGNED_CANDIDATE_REQUIRES_CUSTODIAN'|'BLOCKED';reason:string;binding?:Row;artifacts?:Record<string,Row>;sourceDigest?:string}&typeof flags
/** No caller-supplied identity/amount/recipient replaces a PostgreSQL or Pi fact.
 * The candidate XDR is untrusted until it matches both original records and Pi.
 */
export function produceR36LiveEvidence(input:Input):R36ProducedEvidence{
 try{
  requireFact(Buffer.byteLength(JSON.stringify(input))<=128_000_000,'SOURCE_SIZE')
  const q=clone(input);let scopedEvidence:Row|undefined
  if(q.executionScopeDigest!==undefined){
   const scope=one(q.snapshot.rows.executionScopes??[],r=>r.scope_digest===q.executionScopeDigest&&r.source_wallet===q.sourceWallet,'APPROVED_EXECUTION_SCOPE_REQUIRED')
   const scoped=scopeR36LiveSnapshot(q.snapshot,String(scope.scope_text),q.executionScopeDigest,q.sourceWallet);q.snapshot=scoped.snapshot;scopedEvidence=scoped.evidence
  }
  const d=q.snapshot.rows
  requireFact(hex(q.nonce)&&wallet(q.sourceWallet)&&['settlement','refund'].includes(q.kind)&&
   /^[A-Za-z0-9_.:-]{1,128}$/.test(q.paymentId)&&q.histories.length>0&&q.histories.length<=32,'PRODUCER_SCOPE')
  requireFact(q.snapshot.session.read_only==='on'&&q.snapshot.session.isolation==='repeatable read','CONSISTENT_READONLY_SNAPSHOT_REQUIRED')
  const s=one(d.settlements,x=>x.payment_id===q.paymentId,'ORIGINAL_SETTLEMENT_IDENTITY_REQUIRED')
  const feeQuote=financialContractFromRow(s),outAmount=q.kind==='settlement'?amount(s.merchant_amount):amount(s.customer_amount)
  const creation=one(d.intents,x=>x.payment_id===q.paymentId,'ORIGINAL_CREATE_INTENT_REQUIRED')
  requireFact(creation.merchant_uid===s.merchant_uid&&creation.merchant_id===s.merchant_id&&amount(creation.customer_amount)===amount(s.customer_amount)&&
   (feeQuote!==undefined||amount(s.customer_amount)===amount(s.merchant_amount)&&amount(s.app_commission)==='0')&&text(s.payer_uid)&&text(s.u2a_identifier)&&hex(s.u2a_txid)&&s.u2a_verified_at!=null&&s.u2a_completed_at!=null,'ORIGINAL_AMOUNT_OR_INBOUND_IDENTITY')
  let operationId:unknown,piOutId:unknown,recipient:unknown
  if(q.kind==='settlement'){
   requireFact(['a2u_created','prepared'].includes(String(s.stage))&&!d.refunds.some(r=>r.payment_id===q.paymentId),'SETTLEMENT_ELIGIBILITY_OR_XOR')
   operationId=s.a2u_payment_id;piOutId=s.a2u_payment_id;recipient=s.merchant_uid
  }else{
   const r=one(d.refunds,x=>x.payment_id===q.paymentId,'ORIGINAL_REFUND_IDENTITY_REQUIRED')
   requireFact(r.status==='pending'&&r.stage==='wallet_submission_started'&&r.payer_uid_verified_at!=null&&r.payer_uid===s.payer_uid&&
    amount(r.amount)===amount(s.customer_amount)&&r.source_payment_status==='settlement_failed'&&r.source_settlement_state==='refund_pending'&&
    s.stage==='payment_identity'&&!d.transactions.some(t=>t.payment_id===s.u2a_identifier),'REFUND_ELIGIBILITY_OR_XOR')
   operationId=r.refund_id;piOutId=r.refund_payment_id;recipient=r.payer_uid
  }
  requireFact(text(operationId)&&text(piOutId)&&text(recipient),'ORIGINAL_OUTBOUND_IDENTITY_REQUIRED')
  const prepared=TransactionBuilder.fromXDR(q.preparedEnvelopeXdr,financialNetwork()),pi=q.outboundPi
  requireFact(prepared instanceof Transaction&&prepared.operations.length===1&&prepared.operations[0].type==='payment'&&prepared.operations[0].source===undefined&&prepared.operations[0].asset.isNative(),'PREPARED_OPERATION')
  const op=prepared.operations[0],preparedHash=Buffer.from(prepared.hash()).toString('hex')
  const memo=prepared.memo.value
  const exactMemo=typeof memo==='string'?memo===piOutId:memo instanceof Uint8Array&&Buffer.from(memo).equals(Buffer.from(piOutId,'utf8'))
  requireFact(prepared.toXDR()===q.preparedEnvelopeXdr&&prepared.source===q.sourceWallet&&prepared.memo.type==='text'&&exactMemo&&
   amount(op.amount)===outAmount&&pi.identifier===piOutId&&pi.network===financialNetwork()&&pi.direction==='app_to_user'&&pi.user_uid===recipient&&
   pi.from_address===prepared.source&&pi.to_address===op.destination&&amount(pi.amount)===outAmount&&object(pi.status)&&
   pi.status.developer_approved===true&&pi.status.developer_completed===false&&pi.status.transaction_verified===false&&
   pi.status.cancelled===false&&pi.status.user_cancelled===false&&pi.transaction===null,'PREPARED_ORIGINAL_PI_BINDING')
  if(q.kind==='settlement')requireFact(s.a2u_from_address===prepared.source&&s.a2u_to_address===op.destination&&
   (s.stage!=='prepared'||s.prepared_envelope_xdr===q.preparedEnvelopeXdr&&s.prepared_tx_hash===preparedHash&&String(s.prepared_sequence)===prepared.sequence),'DURABLE_PREPARED_CONFLICT')
  const histories=q.histories.map(normalizeR36ObservedHistory),primary=one(histories,h=>h.sourceWallet===q.sourceWallet,'PRIMARY_HISTORY_REQUIRED')
  const inventory=(primary.snapshot as Row).walletInventory as Row[]
  requireFact(inventory.length===histories.length&&new Set(histories.map(h=>h.sourceWallet)).size===histories.length&&inventory.every(w=>histories.some(h=>h.sourceWallet===w.wallet)),'ALL_WALLETS_REQUIRED')
  const inbound=q.inboundFinality
  requireFact(inbound.schema==='R36_INBOUND_FINALITY_V1'&&hex(inbound.finalityPolicyDigest)&&object(inbound.piRecord)&&object(inbound.horizonRecord)&&object(inbound.horizonInput),'INBOUND_OBSERVATION_REQUIRED')
  const ip=inbound.piRecord,ih=inbound.horizonInput
  requireFact(ip.identifier===s.u2a_identifier&&ip.user_uid===s.payer_uid&&ip.direction==='user_to_app'&&ip.network===financialNetwork()&&ip.to_address===financialIncomingWallet()&&
   amount(ip.amount)===amount(s.customer_amount)&&object(ip.transaction)&&ip.transaction.txid===s.u2a_txid&&ip.transaction.verified===true&&
   object(ip.status)&&ip.status.developer_approved===true&&ip.status.developer_completed===true&&ip.status.transaction_verified===true&&ip.status.cancelled===false&&ip.status.user_cancelled===false&&
   ih.preparedHash===s.u2a_txid&&ih.sourceWallet===ip.from_address&&ih.destinationWallet===financialIncomingWallet()&&amount(ih.amount)===amount(s.customer_amount),'ORIGINAL_INBOUND_MISMATCH')
  const artifacts=composeWalletEvidence(input,histories)
  const binding:Row={network:financialNetwork(),sourceWallet:q.sourceWallet,paymentId:q.paymentId,operationKind:q.kind,operationId,
   preparedHash,preparedSequence:prepared.sequence,piPaymentId:s.u2a_identifier,u2aTxid:s.u2a_txid,destinationWallet:op.destination,amountStroops:outAmount,
   envelopeXdrTextSha256:undefined,cutoffLedger:primary.cutoffLedger,nonce:q.nonce}
  // String payload hashes use raw UTF-8 bytes; snapshot digests use JSON.
  const bytesHash=(v:string)=>createHash('sha256').update(v).digest('hex')
  binding.envelopeXdrTextSha256=bytesHash(q.preparedEnvelopeXdr)
  artifacts.intent={schema:feeQuote?'R36_ORIGINAL_INTENT_V2':'R36_ORIGINAL_INTENT_V1',...(feeQuote?{financialContract:feeQuote,merchantUid:s.merchant_uid}:{}),customerUid:s.payer_uid,...Object.fromEntries(['network','sourceWallet','paymentId','operationKind','operationId','preparedHash','preparedSequence','piPaymentId','u2aTxid','destinationWallet','amountStroops'].map(k=>[k,binding[k]])),envelopeXdr:q.preparedEnvelopeXdr,inboundAmountStroops:amount(s.customer_amount)}
  artifacts.inbound_finality=inbound
  const digestFields={intent:'immutableIntentDigest',inbound_finality:'inboundFinalityDigest',wallet_history:'walletHistoryDigest',accounting:'accountingDigest',exceptions:'exceptionsDigest',exception_isolation:'exceptionIsolationDigest'}
  for(const [kind,key] of Object.entries(digestFields))binding[key]=bytesHash(encodeR36Artifact(artifacts[kind]))
  artifacts.clearance={schema:'R36_WALLET_CLEARANCE_V1',network:financialNetwork(),sourceWallet:q.sourceWallet,cutoffLedger:binding.cutoffLedger,currentRightsDigest:artifacts.accounting.currentRightsDigest,authorityDisposition:'CLEARED_FOR_BOUND_INTENT',...Object.fromEntries(['walletHistoryDigest','accountingDigest','exceptionsDigest','exceptionIsolationDigest'].map(k=>[k,binding[k]]))}
  binding.clearanceDigest=bytesHash(encodeR36Artifact(artifacts.clearance))
  requireFact(R36_ADMISSION_FIELDS.every(k=>text(binding[k])),'PRODUCER_BINDING_INCOMPLETE')
  const review=reviewR36EvidenceSnapshot(binding,artifacts)
  requireFact(review.outcome==='VERIFIED_SNAPSHOT','PRODUCER_'+review.reason)
  return {outcome:'UNSIGNED_CANDIDATE_REQUIRES_CUSTODIAN',reason:'ORIGINAL_FACTS_COMPOSED_NO_TRUST_ATTESTATION',binding,artifacts,sourceDigest:hash(q),...flags}
 }catch(e){return {outcome:'BLOCKED',reason:e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'PRODUCER_SOURCE_OR_PROOF_INVALID',...flags}}
}

/** Compose only exact original history/accounting rows. Both admission and terminal
 * verification use this same mapper; this function grants no authority. */
export function composeR36OriginalWalletEvidence(input:Pick<Input,'snapshot'|'histories'|'sourceWallet'|'paymentId'|'exceptions'|'executionScopeDigest'>):Record<string,Row>{
 return composeWalletEvidence(input)
}
function composeWalletEvidence(input:Pick<Input,'snapshot'|'histories'|'sourceWallet'|'paymentId'|'exceptions'|'executionScopeDigest'>,normalized?:Row[]):Record<string,Row>{
 // Synchronous read-only mapping. Copy only the data returned by reference;
 // execution-scope filtering already owns its own complete source snapshot.
 const q={...input,exceptions:clone(input.exceptions)};let scopedEvidence:Row|undefined
 requireFact(q.snapshot.session.read_only==='on'&&q.snapshot.session.isolation==='repeatable read','CONSISTENT_READONLY_SNAPSHOT_REQUIRED')
 if(q.executionScopeDigest!==undefined){
  const scope=one(q.snapshot.rows.executionScopes??[],r=>r.scope_digest===q.executionScopeDigest&&r.source_wallet===q.sourceWallet,'APPROVED_EXECUTION_SCOPE_REQUIRED')
  const scoped=scopeR36LiveSnapshot(q.snapshot,String(scope.scope_text),q.executionScopeDigest,q.sourceWallet);q.snapshot=scoped.snapshot;scopedEvidence=scoped.evidence
 }
 const d=q.snapshot.rows,histories=normalized??q.histories.map(normalizeR36ObservedHistory),primary=one(histories,h=>h.sourceWallet===q.sourceWallet,'PRIMARY_HISTORY_REQUIRED')
 const inventory=(primary.snapshot as Row).walletInventory as Row[]
 requireFact(inventory.length===histories.length&&new Set(histories.map(h=>h.sourceWallet)).size===histories.length&&inventory.every(w=>histories.some(h=>h.sourceWallet===w.wallet)),'ALL_WALLETS_REQUIRED')
  const groups:Record<string,Row>[]=[]
  // Index only this immutable snapshot. Keep exact cardinality checks below.
  const transactionsByPayment=indexRows(d.transactions,t=>t.payment_id),receiptsByTransaction=indexRows(d.receipts,r=>r.transaction_id),refundsByPayment=indexRows(d.refunds,r=>r.payment_id),refundAccountingById=indexRows(d.refundAccounting,r=>r.refund_id),balancesByMerchant=indexRows(d.merchantBalances,b=>b.merchant_id),refundAuditByRefund=indexRows(d.refundAudit,a=>a.refund_id),settlementsByPayment=indexRows(d.settlements,s=>s.payment_id)
  for(const history of histories){
   const walletId=history.sourceWallet,networkTx=(history.snapshot as Row).transactions as Row[],entries:Row[]=[],merchantUids=new Map<string,string>()
   const networkByHash=indexRows(networkTx,t=>object(t.input)?t.input.preparedHash:undefined)
   const net=(hash:unknown)=>one(networkByHash.get(hash)??[],t=>object(t.input)&&t.input.preparedHash===hash,'ORIGINAL_NETWORK_ACCOUNTING_LINK_REQUIRED')
   for(const cp of d.settlements.filter(v=>v.a2u_from_address===walletId&&v.stage==='db_finalized')){
    const cpQuote=financialContractFromRow(cp)
    const t=one(transactionsByPayment.get(cp.u2a_identifier)??[],t=>t.payment_id===cp.u2a_identifier,'TRANSACTION_CARDINALITY'),r=one(receiptsByTransaction.get(t.id)??[],r=>r.transaction_id===t.id,'RECEIPT_CARDINALITY'),n=net(cp.a2u_txid),i=n.input as Row
    requireFact(!(refundsByPayment.get(cp.payment_id)??[]).some(r=>r.payment_id===cp.payment_id)&&cp.prepared_tx_hash===cp.a2u_txid&&String(cp.prepared_sequence)===i.preparedSequence&&
     cp.horizon_confirmed_at!=null&&cp.pi_completed_at!=null&&cp.db_finalized_at!=null&&cp.a2u_payment_id===r.a2u_identifier&&r.a2u_txid===cp.a2u_txid&&r.txid===cp.a2u_txid&&
     r.u2a_identifier===cp.u2a_identifier&&r.u2a_txid===cp.u2a_txid&&t.status==='completed'&&t.currency==='π'&&r.currency==='π'&&
     t.merchant_uid===cp.merchant_uid&&r.merchant_uid===cp.merchant_uid&&t.merchant_id===cp.merchant_id&&r.merchant_id===cp.merchant_id&&
     [t.amount,r.amount,r.merchant_amount].every(v=>amount(v)===amount(cp.merchant_amount))&&amount(r.customer_amount)===amount(cp.customer_amount)&&amount(r.app_commission)===amount(cp.app_commission)&&(cpQuote!==undefined||amount(cp.merchant_amount)===amount(cp.customer_amount)&&amount(cp.app_commission)==='0')&&
     amount(r.horizon_fee_charged)===String(cp.horizon_fee_stroops)&&r.settlement_status==='settled_to_merchant'&&
     Number(r.app_net_impact)===netImpact(Number(cp.customer_amount),Number(cp.merchant_amount),Number(cp.horizon_fee_stroops)/1e7,cpQuote),'SETTLEMENT_ACCOUNTING_CONFLICT')
    requireFact(!merchantUids.has(String(cp.merchant_id))||merchantUids.get(String(cp.merchant_id))===cp.merchant_uid,'MERCHANT_IDENTITY_CONFLICT');merchantUids.set(String(cp.merchant_id),String(cp.merchant_uid))
    entries.push({entryId:t.id,paymentId:cp.payment_id,operationId:cp.a2u_payment_id,horizonOperationId:n.operationId,transactionHash:cp.a2u_txid,amountStroops:amount(cp.merchant_amount),feeStroops:String(cp.horizon_fee_stroops),destinationWallet:i.destinationWallet,kind:'settlement',stage:'db_finalized',receiptId:r.id,merchantUid:cp.merchant_uid})
   }
   for(const rc of d.refunds.filter(v=>v.status==='completed'&&(networkByHash.get(v.refund_txid)??[]).some(t=>object(t.input)&&t.input.preparedHash===v.refund_txid))){
    const ac=one(refundAccountingById.get(rc.refund_id)??[],a=>a.refund_id===rc.refund_id&&a.payment_id===rc.payment_id,'REFUND_ACCOUNTING_CARDINALITY'),n=net(rc.refund_txid),i=n.input as Row
    const audit=one(refundAuditByRefund.get(rc.refund_id)??[],a=>a.refund_id===rc.refund_id&&a.payment_id===rc.payment_id&&a.event_type==='refund_projection_finalized','REFUND_AUDIT_CARDINALITY')
    let details=audit.details;if(typeof details==='string'){try{details=JSON.parse(details)}catch{throw Error('REFUND_AUDIT_DETAILS')}}
    requireFact(i.sourceWallet===walletId&&rc.stage==='audit_recorded'&&ac.refund_txid===rc.refund_txid&&ac.refund_payment_id===rc.refund_payment_id&&ac.payer_uid===rc.payer_uid&&amount(ac.amount)===amount(rc.amount)&&ac.currency==='π'&&
     audit.event_id==='refund:'+rc.refund_id+':projection_finalized'&&audit.actor_type==='system'&&audit.idempotency_key===rc.idempotency_key&&object(details)&&details.refundPaymentId===rc.refund_payment_id&&details.refundTxid===rc.refund_txid&&
     !(settlementsByPayment.get(rc.payment_id)??[]).some(s=>s.payment_id===rc.payment_id&&s.stage!=='payment_identity'),'REFUND_ACCOUNTING_CONFLICT')
    entries.push({entryId:rc.refund_id,paymentId:rc.payment_id,operationId:rc.refund_id,horizonOperationId:n.operationId,transactionHash:rc.refund_txid,amountStroops:amount(rc.amount),feeStroops:String(ac.horizon_fee_stroops),destinationWallet:i.destinationWallet,kind:'refund',stage:'completed',receiptId:null,merchantUid:null,refundId:rc.refund_id})
   }
   const obligations:Row[]=[]
   for(const r of d.refunds.filter(v=>v.payment_id!==q.paymentId&&['pending','manual_review_required'].includes(String(v.status)))){
    const bindings=d.authorities.filter(a=>a.network===financialNetwork()&&a.operation_kind==='refund'&&a.owner_payment_id===r.payment_id&&a.owner_operation_id===r.refund_id&&a.state==='prepared')
    requireFact(bindings.length===1&&bindings[0].source_wallet!==walletId,'UNRESOLVED_REFUND_RIGHT_NOT_ISOLATED')
    obligations.push({paymentId:r.payment_id,sourceWallet:bindings[0].source_wallet,originalBindingDigest:hash(bindings[0]),disposition:'PROVED_OTHER_WALLET'})
   }
   requireFact(!d.settlements.some(v=>v.payment_id!==q.paymentId&&v.a2u_from_address===walletId&&['a2u_created','prepared','horizon_confirmed','pi_completed'].includes(String(v.stage))),'UNRESOLVED_SETTLEMENT_RIGHT')
   const merchantBalances=[...merchantUids.entries()].map(([id,uid])=>{const b=one(balancesByMerchant.get(id)??[],v=>v.merchant_id===id,'MERCHANT_BALANCE_CARDINALITY');return{merchantUid:uid,creditStroops:amount(b.settled)}})
   const snapshot={schema:'R36_ACCOUNTING_SNAPSHOT_V1',entries,merchantBalances,openObligations:obligations},rights=hash(obligations)
   const records=q.exceptions.records.filter(e=>e.sourceWallet===walletId).map(({sourceWallet,...r})=>r)
   const isolation=q.exceptions.isolation.filter(e=>e.sourceWallet===walletId).map(({sourceWallet,...r})=>r)
   const exceptions:Row={schema:'R36_HISTORICAL_EXCEPTIONS_V1',ids:records.map(r=>String(r.id)).sort(),records,recordsDigest:hash(records)}
   const isolated:Row={schema:'R36_EXCEPTION_ISOLATION_V1',exceptionIds:exceptions.ids,records:isolation,disposition:'ISOLATED_NO_CURRENT_RIGHTS_IMPACT',currentRightsDigest:rights,evidenceDigest:hash(isolation)}
   const accounting:Row={schema:'R36_ACCOUNTING_CLEARANCE_V1',network:financialNetwork(),sourceWallet:walletId,cutoffLedger:history.cutoffLedger,unbalancedStroops:'0',duplicateFinancialKeys:[],xorViolations:[],snapshot,
    pgSnapshotDigest:hash(snapshot),currentRightsDigest:rights,ledgerInventoryDigest:history.transactionsDigest,
    reconciliationDigest:hash({history:history.transactionsDigest,accounting:hash(snapshot),exceptions:exceptions.recordsDigest,isolation:isolated.evidenceDigest,scope:[financialNetwork(),walletId,history.cutoffLedger]})}
   if(scopedEvidence){const scope=JSON.parse(String(scopedEvidence.scopeText));const dual=scope.schema==='R36_CLEAN_NETWORK_EXECUTION_SCOPE_V2'&&financialIncomingWallet()!==q.sourceWallet;requireFact(dual?histories.length===2&&[q.sourceWallet,financialIncomingWallet()].includes(String(walletId)):walletId===q.sourceWallet&&histories.length===1,'EXECUTION_SCOPE_WALLET_INVENTORY');if(walletId===q.sourceWallet)accounting.executionScope=scopedEvidence}
   groups.push({wallet_history:history,accounting,exceptions,exception_isolation:isolated})
  }
  const allEntries=groups.flatMap(g=>(g.accounting.snapshot as Row).entries as Row[])
  const settlementEntryIds=new Set(allEntries.filter(e=>e.kind==='settlement').map(e=>e.entryId)),refundEntryIds=new Set(allEntries.filter(e=>e.kind==='refund').map(e=>e.entryId)),receiptIds=new Set(allEntries.map(e=>e.receiptId))
  const sourceTables:Record<string,Row[]>={transactions:d.transactions,refunds:d.refunds,receipts:d.receipts,settlements:d.settlements}
  for(const e of q.exceptions.records){
   requireFact(text(e.originalTable)&&Object.hasOwn(sourceTables,e.originalTable)&&text(e.originalId),'EXCEPTION_ORIGINAL_SOURCE_REQUIRED')
   const source=one(sourceTables[e.originalTable],r=>String(r.id??r.refund_id??r.payment_id)===e.originalId,'EXCEPTION_ORIGINAL_SOURCE_CARDINALITY')
   requireFact(e.originalRecordDigest===hash(source),'EXCEPTION_ORIGINAL_DIGEST_CONFLICT')
   requireFact(!(e.originalTable==='refunds'&&source.status!=='completed'),'UNRESOLVED_REFUND_CANNOT_BE_DISPOSED')
  }
  const disposed=(table:string,row:Row)=>q.exceptions.records.some(e=>e.originalTable===table&&e.originalId===String(row.id??row.refund_id??row.payment_id)&&e.originalRecordDigest===hash(row))
  requireFact(d.transactions.filter(t=>t.status==='completed').every(t=>settlementEntryIds.has(t.id)||disposed('transactions',t)),'UNMAPPED_DURABLE_TRANSACTION')
  requireFact(d.receipts.every(r=>receiptIds.has(r.id)||disposed('receipts',r)),'UNMAPPED_DURABLE_RECEIPT')
  requireFact(d.refunds.filter(r=>r.status==='completed').every(r=>refundEntryIds.has(r.refund_id)||disposed('refunds',r)),'UNMAPPED_DURABLE_REFUND')
  const primaryIndex=histories.indexOf(primary),artifacts={...groups[primaryIndex]} as Record<string,Row>
  for(const kind of ['wallet_history','accounting','exceptions','exception_isolation'])artifacts[kind]={...artifacts[kind],relatedWallets:groups.filter((_,i)=>i!==primaryIndex).map(g=>({...g[kind],network:financialNetwork(),sourceWallet:g.wallet_history.sourceWallet,cutoffLedger:g.wallet_history.cutoffLedger}))}
 return artifacts
}
