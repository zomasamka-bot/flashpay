import 'server-only'
import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash,randomUUID} from 'node:crypto'
import type {WalletAuthorityClaim} from './financial-wallet-authority'
import {currentRecoveryRight} from './r36-recovery-scope'

// Temporary observation only. This module must never return an admission/right,
// invoke a financial writer, alter SQL/ACL, or become an input to a guard.
export const PREPARED_TRACE_UNTIL = '2026-11-13T12:00:00.000Z'
const active=new AsyncLocalStorage<{attemptId:string;paymentId:string;preparedTag:string;kind:string;started:number}>()
const observed=new Map<string,number>()
let attempts=0
function enabled(){return process.env.FLASHPAY_PREPARED_TRACE!=='off' && Date.now()<Date.parse(PREPARED_TRACE_UNTIL)}
function tag(v:unknown){return typeof v==='string'?createHash('sha256').update(v).digest('hex').slice(0,16):'invalid'}
export function preparedTraceEvent(event:string,facts:Record<string,boolean|number|null>={}) {
 try {
  const c=active.getStore();if(!c||!enabled())return
  const safe:Record<string,boolean|number|null>={}
  for(const[k,v]of Object.entries(facts))if(/^[a-zA-Z][a-zA-Z0-9_]{0,55}$/.test(k)&&(typeof v==='boolean'||v===null||typeof v==='number'&&Number.isFinite(v)))safe[k]=v
  console.info('[R36 PREPARED TRACE]',{v:1,event,attemptId:c.attemptId,paymentId:c.paymentId,preparedTag:c.preparedTag,kind:c.kind,at:new Date().toISOString(),elapsedMs:Date.now()-c.started,...safe})
 }catch{/* Diagnostic failure never changes a financial decision. */}
}
export function preparedTraceError(event:string,error:unknown) {
 const code=(error as {code?:unknown})?.code
 // Numeric representation avoids logging arbitrary error messages or fields.
 const states=['23505','40001','40P01','42501','57014','P0001','P6401','25P02']
 preparedTraceEvent(event,{knownSqlstate:typeof code==='string'?states.indexOf(code):-1})
}
export async function withPreparedTrace<T>(input:WalletAuthorityClaim,work:()=>Promise<T>):Promise<T>{
 if(active.getStore()||!enabled()||attempts>=128)return work()
 let context:NonNullable<ReturnType<typeof active.getStore>>
 try{context={attemptId:randomUUID(),paymentId:/^[0-9a-f-]{36}$/.test(input.paymentId)?input.paymentId:'invalid',preparedTag:tag(input.preparedHash),kind:input.operationKind==='refund'?'refund':'settlement',started:Date.now()};attempts++}catch{return work()}
 return active.run(context,work)
}
export function tracePreparedScope(input:WalletAuthorityClaim,matched:boolean){
 const r=currentRecoveryRight()
 preparedTraceEvent('scope_checked',{matched,present:!!r,spent:r?.spent??null,paymentMatches:r?input.paymentId===r.id:null,walletMatches:r?input.sourceWallet===r.wallet:null,kindMatches:r?input.operationKind===r.kind:null,operationMatches:r?input.operationId===r.op:null,hashMatches:r?input.preparedHash===r.hash:null,sequenceMatches:r?input.preparedSequence===r.seq:null})
}

// One read-only observation AFTER the caller transaction has rolled back.
// This is a separate committed snapshot, not the SQL guard's decision snapshot.
// Never interpret it as authorization. No locks, SQL functions, raw bindings,
// wallets, UIDs, signatures, keys, or envelopes are returned to the log.
export async function observePreparedRefusal(input:WalletAuthorityClaim):Promise<void>{
 if(!enabled()||!active.getStore())return
 const key=tag(input.paymentId+'|'+input.preparedHash),now=Date.now()
 if(observed.has(key))return
 if(observed.size>=128)observed.delete(observed.keys().next().value!)
 observed.set(key,now)
 try{
  const {readPreparedTraceObservation}=await import('./db')
  const rows=await readPreparedTraceObservation(input)
  const row=Array.isArray(rows)&&rows.length===1&&rows[0]&&typeof rows[0]==='object'?rows[0] as Record<string,unknown>:null
  if(!row){preparedTraceEvent('post_rollback_observation_unavailable');return}
  const safe:Record<string,boolean|number|null>={afterRollback:true,independentSnapshot:true}
  for(const name of ['policy_present','policy_enabled','policy_time_valid','wallet_enabled','reservation_present','reservation_active_bound','creation_identity_matches','exact_request_count','receipt_count','original_receipt_time_valid','renewal_present','certificate_revoked','revocation_window_valid','clearance_matches','attestation_matches','manifest_matches','inbound_binding_matches','other_wallet_owner_present']){
   const v=row[name];safe[name]=typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)?v:null
  }
  preparedTraceEvent('post_rollback_observation',safe)
 }catch(error){preparedTraceError('post_rollback_observation_failed',error)}
}
