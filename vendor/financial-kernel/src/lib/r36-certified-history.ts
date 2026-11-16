/** Immutable historical FACTS, never a current financial permission. A context
 * is loaded by the protected issuer/source from PostgreSQL. Artifact-supplied
 * summaries are not accepted as a trusted checkpoint. Current policy, identity,
 * cancellation, expiry, finality and wallet authority checks remain at use. */
import {createHash} from 'node:crypto'
import {financialNetwork} from './financial-network'
import {deployment} from '../deployment'
type Row=Record<string,unknown>
export type R36HistoryCheckpoint={
 schema:'R36_CERTIFIED_HISTORY_CHECKPOINT_V1';applicationId:string;network:string;policyDigest:string;sourceWallet:string;
 parentDigest:string|null;executionScopeDigest:string;genesisHash:string;cutoffLedger:string;cutoffHash:string;
 closingBalanceStroops:string;closingSequence:string;transactionsCount:string;accountingCount:string;
 historyRoot:string;accountingRoot:string;closureDigest:string;sourceRowsDigest:string;deltaHistoryDigest:string;deltaAccountingDigest:string;
 terminalTransaction:Row;terminalEntry:Row;originalCursor:string
}
export type R36CheckpointContext={digest:string;checkpoint:R36HistoryCheckpoint;credits:Row[];inbound?:Row;openingBalances?:Row[]}
const contexts=new WeakSet<object>()
function deepFreeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value)}return value}
const obj=(x:unknown):x is Row=>!!x&&typeof x==='object'&&!Array.isArray(x)
const hex=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x)
const uint=(x:unknown):x is string=>typeof x==='string'&&/^(0|[1-9][0-9]{0,29})$/.test(x)
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
function must(x:unknown,reason:string):asserts x{if(!x)throw Error(reason)}
const fields=['schema','applicationId','network','policyDigest','sourceWallet','parentDigest','executionScopeDigest','genesisHash','cutoffLedger','cutoffHash','closingBalanceStroops','closingSequence','transactionsCount','accountingCount','historyRoot','accountingRoot','closureDigest','sourceRowsDigest','deltaHistoryDigest','deltaAccountingDigest','terminalTransaction','terminalEntry','originalCursor']
export function validateR36HistoryCheckpoint(value:unknown):R36HistoryCheckpoint{
 must(obj(value)&&Object.keys(value).length===fields.length&&fields.every(k=>Object.hasOwn(value,k)),'CHECKPOINT_FIELDS')
 const c=value as unknown as R36HistoryCheckpoint
 must(c.schema==='R36_CERTIFIED_HISTORY_CHECKPOINT_V1'&&c.applicationId===deployment().applicationId&&c.network===financialNetwork()&&
  /^G[A-Z2-7]{55}$/.test(c.sourceWallet)&&[c.policyDigest,c.executionScopeDigest,c.genesisHash,c.cutoffHash,c.historyRoot,c.accountingRoot,c.closureDigest,c.sourceRowsDigest,c.deltaHistoryDigest,c.deltaAccountingDigest].every(hex)&&
  (c.parentDigest===null||hex(c.parentDigest))&&[c.cutoffLedger,c.closingBalanceStroops,c.closingSequence,c.transactionsCount,c.accountingCount,c.originalCursor].every(uint)&&obj(c.terminalTransaction)&&obj(c.terminalEntry),'CHECKPOINT_SCOPE')
 const t=c.terminalTransaction,e=c.terminalEntry
 must(obj(t.input)&&obj(t.record)&&t.input.sourceWallet===c.sourceWallet&&t.input.preparedSequence===c.closingSequence&&t.record.successful===true&&
  uint(t.operationId)&&BigInt(t.operationId)/4294967296n===BigInt(String(t.record.ledger))&&BigInt(String(t.record.ledger))<=BigInt(c.cutoffLedger)&&
  e.transactionHash===t.input.preparedHash&&e.horizonOperationId===t.operationId&&['settlement','refund'].includes(String(e.kind)),'CHECKPOINT_TERMINAL')
 must(BigInt(c.transactionsCount)<=BigInt(Number.MAX_SAFE_INTEGER)&&BigInt(c.accountingCount)<=BigInt(Number.MAX_SAFE_INTEGER),'CHECKPOINT_COUNT_PRECISION')
 return c
}
/** Only call with an original protected database response. Input artifacts never
 * reach this constructor. JSON serialization cannot retain this capability. */
export function checkpointFromDatabase(value:unknown,policy:string,wallet:string):R36CheckpointContext{
 must(obj(value)&&hex(value.digest)&&typeof value.checkpointText==='string'&&Buffer.byteLength(value.checkpointText)<=100000&&Array.isArray(value.credits)&&value.credits.length<=20000,'CHECKPOINT_DATABASE_RESPONSE')
 const c=validateR36HistoryCheckpoint(JSON.parse(value.checkpointText as string))
 must(c.policyDigest===policy&&c.sourceWallet===wallet&&hash(c)===value.digest,'CHECKPOINT_DATABASE_IDENTITY')
 const seen=new Set<string>();for(const r of value.credits){must(obj(r)&&(r.merchantId===undefined||r.merchantId===null||typeof r.merchantId==='string'&&r.merchantId.length<=128)&&(r.openingStroops===undefined||r.openingStroops===null||uint(r.openingStroops))&&typeof r.merchantUid==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(r.merchantUid)&&uint(r.creditStroops)&&!seen.has(r.merchantUid),'CHECKPOINT_CREDIT');seen.add(r.merchantUid)}
 if(value.openingBalances!==undefined){must(Array.isArray(value.openingBalances)&&value.openingBalances.length<=20000,'CHECKPOINT_OPENINGS');const ids=new Set<string>();for(const r of value.openingBalances){must(obj(r)&&typeof r.merchantId==='string'&&r.merchantId.length>0&&r.merchantId.length<=128&&uint(r.settled)&&uint(r.unsettled)&&!ids.has(r.merchantId),'CHECKPOINT_OPENING_ROW');ids.add(r.merchantId)}}
 if(value.inbound!==undefined&&value.inbound!==null){
  const t=value.inbound;must(obj(t)&&obj(t.input)&&obj(t.record)&&t.input.destinationWallet===wallet&&t.input.sourceWallet!==wallet&&hex(t.input.preparedHash)&&uint(t.operationId)&&t.record.successful===true&&/^[1-9][0-9]*$/.test(String(t.record.ledger))&&BigInt(String(t.record.ledger))<=BigInt(c.cutoffLedger)&&BigInt(t.operationId)/4294967296n===BigInt(String(t.record.ledger)),'CHECKPOINT_INBOUND_WITNESS')
 }
 const out=deepFreeze({digest:value.digest,checkpoint:structuredClone(c),credits:structuredClone(value.credits) as Row[],...(Array.isArray(value.openingBalances)?{openingBalances:structuredClone(value.openingBalances) as Row[]} : {}),...(obj(value.inbound)?{inbound:structuredClone(value.inbound)}:{})});contexts.add(out);return out
}
export function assertR36CheckpointContext(context:R36CheckpointContext|undefined,pointer:unknown,wallet:unknown):R36HistoryCheckpoint|undefined{
 if(pointer===undefined){must(context===undefined,'CHECKPOINT_UNEXPECTED');return undefined}
 must(context&&contexts.has(context)&&hex(pointer)&&context.digest===pointer&&context.checkpoint.sourceWallet===wallet&&hash(context.checkpoint)===context.digest,'CHECKPOINT_NOT_RESOLVED')
 return context.checkpoint
}
export async function resolveR36HistoryCheckpoint(tx:{unsafe(sql:string,args:unknown[]):Promise<Row[]>},policy:string,wallet:string,artifacts:Record<string,Row>,profile:Row,inbound?:string){
 const h=artifacts.wallet_history?.snapshot,a=artifacts.accounting?.snapshot
 if(!obj(h)||h.checkpointDigest===undefined)return undefined
 must(hex(h.checkpointDigest)&&obj(a)&&Array.isArray(a.merchantBalances),'CHECKPOINT_NOT_ENROLLED')
 const merchants=a.merchantBalances.map(r=>{must(obj(r)&&(r.merchantId===undefined||r.merchantId===null||typeof r.merchantId==='string'&&r.merchantId.length<=128)&&(r.openingStroops===undefined||r.openingStroops===null||uint(r.openingStroops))&&typeof r.merchantUid==='string','CHECKPOINT_MERCHANT');return r.merchantUid})
 const result=await tx.unsafe('SELECT public.r36_history_checkpoint_context($1,$2,$3,$4::text::jsonb,$5) AS context',[policy,wallet,h.checkpointDigest,JSON.stringify(merchants),inbound??null])
 must(result.length===1&&result[0].context!==null,'CHECKPOINT_UNAVAILABLE_OR_REVOKED')
 return checkpointFromDatabase(result[0].context,policy,wallet)
}
export function deriveR36HistoryCheckpoint(input:{policyDigest:string;executionScopeDigest:string;closureDigest:string;sourceRowsDigest:string;originalCursor:string;artifacts:Record<string,Row>;parent?:R36CheckpointContext}):R36HistoryCheckpoint{
 const h=input.artifacts.wallet_history.snapshot as Row,a=input.artifacts.accounting.snapshot as Row
 must(obj(h)&&obj(a)&&obj(h.genesis)&&Array.isArray(h.transactions)&&Array.isArray(a.entries),'CHECKPOINT_VERIFIED_SNAPSHOT_REQUIRED')
 must(Array.isArray(h.walletInventory)&&h.walletInventory.length===1,'CHECKPOINT_MULTI_WALLET_NOT_ENROLLED')
 must(Array.isArray(input.artifacts.exceptions?.records)&&input.artifacts.exceptions.records.length===0,'CHECKPOINT_EXCEPTION_SCOPE_NOT_ENROLLED')
 const parent=assertR36CheckpointContext(input.parent,h.checkpointDigest,h.wallet)
 const txs=h.transactions as Row[],entries=a.entries as Row[]
 // A new checkpoint must close a NEW terminal outflow. An idle observation of
 // the same terminal cannot append duplicate checkpoint history.
 const last=txs.filter(t=>obj(t.input)&&t.input.sourceWallet===h.wallet&&obj(t.record)&&t.record.successful===true).at(-1)
 must(last&&obj(last.input),'CHECKPOINT_NO_NEW_TERMINAL')
 const lastInput=last.input as Row
 const linked=entries.filter(e=>e.transactionHash===lastInput.preparedHash)
 must(linked.length===1&&last.input.preparedSequence===h.closingSequence,'CHECKPOINT_TERMINAL_ACCOUNTING')
 return validateR36HistoryCheckpoint({schema:'R36_CERTIFIED_HISTORY_CHECKPOINT_V1',applicationId:deployment().applicationId,network:financialNetwork(),policyDigest:input.policyDigest,sourceWallet:h.wallet,
  parentDigest:input.parent?.digest??null,executionScopeDigest:input.executionScopeDigest,genesisHash:h.genesis.hash,cutoffLedger:h.cutoffLedger,cutoffHash:h.cutoffHash,
  closingBalanceStroops:h.closingBalanceStroops,closingSequence:h.closingSequence,transactionsCount:String(BigInt(parent?.transactionsCount??'0')+BigInt(txs.length)),accountingCount:String(BigInt(parent?.accountingCount??'0')+BigInt(entries.length)),
  historyRoot:hash(['R36_HISTORY_CHAIN_V1',parent?.historyRoot??null,txs]),accountingRoot:hash(['R36_ACCOUNTING_CHAIN_V1',parent?.accountingRoot??null,entries]),
  closureDigest:input.closureDigest,sourceRowsDigest:input.sourceRowsDigest,deltaHistoryDigest:hash(txs),deltaAccountingDigest:hash(entries),terminalTransaction:last,terminalEntry:linked[0],originalCursor:input.originalCursor})
}
export const r36HistoryCheckpointDigest=hash
