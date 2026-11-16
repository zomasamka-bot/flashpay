import {assertR36CheckpointContext,type R36CheckpointContext} from './r36-certified-history'
import {type FinancialNetwork,financialNetwork} from './financial-network'
/** A new-wallet accounting boundary, not disposition of historical rights.
 * Protected enrollment pins the complete opening records and genesis evidence.
 * Any opening-row drift, missing hold, overlap or unapproved scope fails closed.
 */
import {createHash} from 'node:crypto'
import {Transaction,TransactionBuilder} from '@stellar/stellar-sdk'
import {reviewR36WalletBootstrapSnapshot} from './r36-evidence-snapshot'
import type {R36LiveSnapshot,R36SourceRow as Row} from './r36-live-source'
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
const hash=(x:unknown)=>sha(JSON.stringify(x))
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)
function must(v:unknown,why:string):asserts v{if(!v)throw Error(why)}
function units(v:unknown):bigint{must(typeof v==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(v),'SCOPE_AMOUNT');const[a,b='']=v.split('.');must(/^0*$/.test(b.slice(7)),'SCOPE_PRECISION');return BigInt(a)*BigInt(10000000)+BigInt(b.slice(0,7).padEnd(7,'0'))}
const pi=(n:bigint)=>`${n/BigInt(10000000)}.${(n%BigInt(10000000)).toString().padStart(7,'0')}`
const keys={intents:['payment_id'],settlements:['payment_id'],refunds:['refund_id'],transactions:['id'],receipts:['id'],refundAccounting:['refund_id'],refundAudit:['event_id'],authorities:['network','source_wallet'],authorityHistory:['network','source_wallet','prepared_tx_hash']} as const
export type R36ExecutionScope={schema:'R36_NEW_WALLET_EXECUTION_SCOPE_V1'|'R36_CLEAN_NETWORK_EXECUTION_SCOPE_V2';network:FinancialNetwork;sourceWallet:string;genesisHash:string;genesisClosedAt:string;capturedAt:string;accountAtOpening:Row;genesisLedgerRecord:Row;baseline:Record<string,Row[]>;legacyHolds:Row[];bootstrap:Record<string,Row>;oldRightsDisposition:'DEFERRED_PRESERVED_NO_RESEND';oldRightsFinanciallyCleared:false}
export function parseR36ExecutionScope(text:unknown,digest:unknown,wallet:unknown):R36ExecutionScope{
 must(typeof text==='string'&&Buffer.byteLength(text)<=2_000_000&&hex(digest)&&sha(text)===digest,'SCOPE_PROTECTED_DIGEST')
 const s=JSON.parse(text) as R36ExecutionScope
 must(object(s)&&['R36_NEW_WALLET_EXECUTION_SCOPE_V1','R36_CLEAN_NETWORK_EXECUTION_SCOPE_V2'].includes(s.schema)&&s.network===financialNetwork()&&s.sourceWallet===wallet&&typeof wallet==='string'&&/^G[A-Z2-7]{55}$/.test(wallet)&&hex(s.genesisHash)&&s.oldRightsDisposition==='DEFERRED_PRESERVED_NO_RESEND'&&s.oldRightsFinanciallyCleared===false&&object(s.baseline)&&Array.isArray(s.legacyHolds)&&object(s.bootstrap),'SCOPE_CONTRACT')
 const birth=Date.parse(s.genesisClosedAt),at=Date.parse(s.capturedAt);must(Number.isFinite(birth)&&Number.isFinite(at)&&birth<=at,'SCOPE_CLOCK')
 must(object(s.bootstrap.wallet_history)&&object(s.bootstrap.wallet_history.snapshot)&&object(s.bootstrap.wallet_history.snapshot.genesis)&&s.bootstrap.wallet_history.snapshot.genesis.hash===s.genesisHash,'SCOPE_GENESIS')
 must(reviewR36WalletBootstrapSnapshot({network:s.network,sourceWallet:s.sourceWallet,cutoffLedger:s.bootstrap.wallet_history.cutoffLedger},s.bootstrap).outcome==='VERIFIED_SNAPSHOT','SCOPE_BOOTSTRAP_NOT_PROVEN')
 const history=s.bootstrap.wallet_history.snapshot,genesis=history.genesis as Row,account=s.accountAtOpening,ledger=s.genesisLedgerRecord
 must(object(account)&&account.account_id===wallet&&String(account.sequence)===history.closingSequence&&String(account.last_modified_ledger)===genesis.ledger&&Array.isArray(account.signers)&&account.signers.length===1&&object(account.signers[0])&&account.signers[0].key===wallet&&account.signers[0].weight===1&&account.signers[0].type==='ed25519_public_key','SCOPE_INHERITED_SIGNING_AUTHORITY')
 must(Array.isArray(account.balances)&&account.balances.length===1&&object(account.balances[0])&&account.balances[0].asset_type==='native'&&units(account.balances[0].balance).toString()===history.closingBalanceStroops&&units(account.balances[0].buying_liabilities)===BigInt(0)&&units(account.balances[0].selling_liabilities)===BigInt(0),'SCOPE_ENCUMBERED_OPENING_BALANCE')
 must(object(ledger)&&String(ledger.sequence)===genesis.ledger&&ledger.hash===history.cutoffHash&&ledger.closed_at===s.genesisClosedAt,'SCOPE_ORIGINAL_GENESIS_LEDGER')
 for(const k of [...Object.keys(keys),'merchantBalances'])must(Array.isArray(s.baseline[k])&&s.baseline[k].length<=20000&&s.baseline[k].every(object),'SCOPE_BASELINE_ROWS')
 must(s.schema==='R36_NEW_WALLET_EXECUTION_SCOPE_V1'?s.legacyHolds.length>0:s.legacyHolds.length===0&&Object.values(s.baseline).every(rows=>rows.length===0),'SCOPE_CLEAN_NETWORK_REQUIRES_EMPTY_ORIGINAL_LEDGER')
 must(!s.baseline.settlements.some(r=>r.a2u_from_address===wallet)&&!s.baseline.authorities.some(r=>r.source_wallet===wallet)&&!s.baseline.authorityHistory.some(r=>r.source_wallet===wallet),'SCOPE_INHERITED_WALLET')
 const created=TransactionBuilder.fromXDR(String(genesis.envelopeXdr),financialNetwork()),oldWallets=new Set(s.baseline.settlements.map(r=>r.a2u_from_address).filter(x=>typeof x==='string'))
 must(created instanceof Transaction&&created.operations.length===1&&created.operations[0].type==='createAccount'&&!oldWallets.has(created.source)&&!oldWallets.has(created.operations[0].source??created.source),'SCOPE_OLD_WALLET_FUNDED_NEW_SCOPE')
 const seen=new Set<string>()
 for(const h of s.legacyHolds){must(typeof h.payment_id==='string'&&!seen.has(h.payment_id)&&h.network===financialNetwork()&&h.state==='HELD_UNRESOLVED_NO_RESEND'&&h.authorizes_new_rights===false&&hex(h.original_snapshot_sha256)&&typeof h.held_at==='string'&&Date.parse(h.held_at)<birth,'SCOPE_DURABLE_HOLD');seen.add(h.payment_id)}
 must(s.baseline.refunds.filter(r=>['pending','manual_review_required'].includes(String(r.status))).every(r=>s.legacyHolds.some(h=>h.kind==='refund'&&h.payment_id===r.payment_id)),'SCOPE_UNHELD_REFUND')
 must(s.baseline.settlements.filter(r=>['a2u_created','prepared','horizon_confirmed','pi_completed'].includes(String(r.stage))).every(r=>r.a2u_from_address!==wallet&&s.legacyHolds.some(h=>h.kind==='settlement'&&h.payment_id===r.payment_id)),'SCOPE_UNHELD_SETTLEMENT')
 return s
}
/** An activated checkpoint seals the opening scope and all closed source rows.
 * The current signed artifact references that protected fact, never a summary
 * supplied by the caller. Open/delta rows still receive the original checks. */
export function scopeR36CurrentSnapshot(snapshot:R36LiveSnapshot,scopeDigest:string,wallet:string):{snapshot:R36LiveSnapshot;evidence:Row}{
 if(snapshot.checkpoint){
  const anchor=snapshot.checkpoint,c=assertR36CheckpointContext(anchor,anchor.digest,wallet)!
  must(c.executionScopeDigest===scopeDigest,'CHECKPOINT_EXECUTION_SCOPE')
  const copy=JSON.parse(JSON.stringify(snapshot)) as R36LiveSnapshot;copy.checkpoint=anchor
  const openings=new Map((anchor.openingBalances??[]).map(r=>[String(r.merchantId),r]))
  copy.rows.merchantBalances=copy.rows.merchantBalances.map(r=>{const base=openings.get(String(r.merchant_id));if(!base)return r;const settled=units(r.settled)-BigInt(String(base.settled)),unsettled=units(r.unsettled)-BigInt(String(base.unsettled));must(settled>=0n&&unsettled>=0n,'SCOPE_OPENING_BALANCE_REDUCED');return{...r,settled:pi(settled),unsettled:pi(unsettled)}})
  return{snapshot:copy,evidence:{schema:'R36_CHECKPOINT_EXECUTION_SCOPE_V1',scopeDigest,checkpointDigest:anchor.digest,sourceRowsDigest:hash(snapshot.rows),oldRightsFinanciallyCleared:false}}
 }
 const scopes=snapshot.rows.executionScopes.filter(r=>r.scope_digest===scopeDigest&&r.source_wallet===wallet)
 must(scopes.length===1,'APPROVED_EXECUTION_SCOPE_REQUIRED')
 return scopeR36LiveSnapshot(snapshot,String(scopes[0].scope_text),scopeDigest,wallet)
}
export function scopeR36LiveSnapshot(snapshot:R36LiveSnapshot,scopeText:string,scopeDigest:string,wallet:string):{snapshot:R36LiveSnapshot;evidence:Row}{
 const s=parseR36ExecutionScope(scopeText,scopeDigest,wallet),copy=JSON.parse(JSON.stringify(snapshot)) as R36LiveSnapshot,d=copy.rows as Record<string,Row[]>
 must(snapshot.session.read_only==='on'&&snapshot.session.isolation==='repeatable read','SCOPE_CONSISTENT_SOURCE')
 must(Array.isArray(d.legacyHolds)&&hash(d.legacyHolds)===hash(s.legacyHolds),'SCOPE_HOLD_CHANGED')
 for(const [name,fields]of Object.entries(keys)){
  const rows=d[name],base=s.baseline[name];must(Array.isArray(rows),'SCOPE_SOURCE_ROWS')
  const id=(r:Row)=>JSON.stringify(fields.map(k=>r[k])),current=new Map(rows.map(r=>[id(r),r])),excluded=new Set<string>()
  must(current.size===rows.length,'SCOPE_DUPLICATE_SOURCE_ID')
  for(const r of base){const key=id(r);must(!excluded.has(key)&&current.has(key)&&hash(current.get(key))===hash(r),'SCOPE_OPENING_RECORD_CHANGED');excluded.add(key)}
  d[name]=rows.filter(r=>!excluded.has(id(r)))
 }
 const opening=new Map(s.baseline.merchantBalances.map(r=>[r.merchant_id,r]));must(opening.size===s.baseline.merchantBalances.length,'SCOPE_DUPLICATE_BALANCE')
 must(s.baseline.merchantBalances.every(r=>d.merchantBalances.some(c=>c.merchant_id===r.merchant_id)),'SCOPE_OPENING_BALANCE_MISSING')
 d.merchantBalances=d.merchantBalances.map(r=>{const b=opening.get(r.merchant_id);if(!b)return r;const settled=units(r.settled)-units(b.settled),unsettled=units(r.unsettled)-units(b.unsettled);must(settled>=BigInt(0)&&unsettled>=BigInt(0),'SCOPE_OPENING_BALANCE_REDUCED');return {...r,settled:pi(settled),unsettled:pi(unsettled)}})
 return {snapshot:copy,evidence:{schema:'R36_APPROVED_EXECUTION_SCOPE_BINDING_V1',scopeDigest,scopeText,baselineDigest:hash(s.baseline),sourceRowsDigest:hash(snapshot.rows),oldRightsFinanciallyCleared:false}}
}
/** Worker and terminal reviewer call this after authenticating the signed body.
 * A signed scope is still rejected unless the protected policy pins it exactly.
 */
export function assertR36ExecutionScopePolicy(profile:Row,artifacts:Record<string,Row>,wallet:string,anchor?:R36CheckpointContext):void{
 const e=artifacts.accounting?.executionScope
 if(anchor){const c=assertR36CheckpointContext(anchor,(artifacts.wallet_history?.snapshot as Row)?.checkpointDigest,wallet)!;must(c.executionScopeDigest===profile.executionScopeDigest&&object(e)&&e.schema==='R36_CHECKPOINT_EXECUTION_SCOPE_V1'&&e.scopeDigest===c.executionScopeDigest&&e.checkpointDigest===anchor.digest&&hex(e.sourceRowsDigest)&&e.oldRightsFinanciallyCleared===false,'CHECKPOINT_SCOPE_POLICY');return}
 if(profile.executionScopeDigest===undefined){must(e===undefined,'SCOPE_NOT_APPROVED');return}
 must(hex(profile.executionScopeDigest)&&object(e)&&e.schema==='R36_APPROVED_EXECUTION_SCOPE_BINDING_V1'&&e.scopeDigest===profile.executionScopeDigest&&e.oldRightsFinanciallyCleared===false&&hex(e.sourceRowsDigest),'SCOPE_POLICY_BINDING')
 const s=parseR36ExecutionScope(e.scopeText,e.scopeDigest,wallet)
 must(e.baselineDigest===hash(s.baseline)&&object(artifacts.wallet_history.snapshot)&&object(artifacts.wallet_history.snapshot.genesis)&&artifacts.wallet_history.snapshot.genesis.hash===s.genesisHash,'SCOPE_HISTORY_BINDING')
}
