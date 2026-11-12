import {preparedTraceEvent,preparedTraceError} from './r36-prepared-trace'
import 'server-only'
import {createHash} from 'node:crypto'
import {currentRecoveryRight} from './r36-recovery-scope'
import type {WalletAuthorityClaim} from './financial-wallet-authority'
import {getR36RestrictedClient} from './db'
import {ensurePrivateTrustHost} from './r36-private-host-wake'

export function requiresTestnetIngress() {
  return process.env.VERCEL_ENV === 'production' || process.env.FLASHPAY_RECOVERY_SCOPE === 'admitted_new'
}
export function testnetIngressEnabled() {
  return process.env.FLASHPAY_RECOVERY_SCOPE === 'admitted_new'
}
function stroops(amount:unknown) {
  if(typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 1000000 || Number(amount.toFixed(7)) !== amount) return null
  return String(Math.round(amount * 10000000))
}
async function invoke(action:'reserve'|'bind'|'verify'|'inbound'|'approval', input:Record<string,string>):Promise<string|null> {
  if(!testnetIngressEnabled()) return null
  const policy=process.env.R36_SCOPED_POLICY_DIGEST
  if(!policy || !/^[0-9a-f]{64}$/.test(policy)) return null
  try {
    const client=await getR36RestrictedClient()
    if(!client) { console.warn('[R36 ingress]',{action,phase:'runtime_unavailable'});return null }
    const rows=await client.unsafe('SELECT public.r36_prepare_testnet_ingress($1,$2,$3::text::jsonb) AS admission',[action,policy,JSON.stringify(input)])
    const id=rows.length===1?rows[0].admission?.paymentId:null
    return typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)?id:null
  } catch (error) {
    const code=(error as {code?:unknown})?.code
    console.warn('[R36 ingress]',{action,phase:'database_rejected',sqlstate:typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)?code:'unavailable'})
    return null
  }
}
export async function reserveTestnetCreation(input:{paymentId:string;createIntentId:string;merchantUid:string;merchantId:string;amount:number;note:string;merchantWallet?:string}) {
  const amountStroops=stroops(input.amount)
  if(!amountStroops) return null
  const {amount,note,...identity}=input
  return invoke('reserve',{...identity,merchantWallet:input.merchantWallet??'',walletContract:'PI_PAYMENT_DTO_V1',amountStroops,noteDigest:createHash('sha256').update(note).digest('hex')})
}
export async function bindTestnetPayer(paymentId:string,payerUid:string,payerWallet?:string) {
  if(!await ensurePrivateTrustHost('payer'))return false
  return await invoke('bind',{paymentId,payerUid,payerWallet:payerWallet??''}) === paymentId
}
export async function verifyTestnetInbound(payment:unknown) {
  if(!payment || typeof payment!=='object')return false
  const p=payment as Record<string,unknown>,meta=p.metadata as {paymentId?:unknown}|undefined
  const amountStroops=stroops(p.amount)
  if(p.network!=='Pi Testnet' || p.direction!=='user_to_app' || !amountStroops || typeof meta?.paymentId!=='string' ||
    typeof p.user_uid!=='string' || typeof p.from_address!=='string' || typeof p.to_address!=='string')return false
  const identity={paymentId:meta.paymentId,payerUid:p.user_uid,fromAddress:p.from_address,toAddress:p.to_address,amountStroops}
  if(p.transaction===null) return await invoke('verify',identity)===meta.paymentId
  const t=p.transaction as Record<string,unknown>|undefined,s=p.status as Record<string,unknown>|undefined
  if(!t||!s||typeof p.identifier!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(p.identifier)||
    typeof t.txid!=='string'||!/^[0-9a-f]{64}$/.test(t.txid)||t.verified!==true||
    s.developer_approved!==true||s.transaction_verified!==true||s.cancelled!==false||s.user_cancelled!==false||
    typeof s.developer_completed!=='boolean'||!/^G[A-Z2-7]{55}$/.test(p.from_address)||!/^G[A-Z2-7]{55}$/.test(p.to_address))return false
  return await invoke('inbound',{...identity,piPaymentId:p.identifier,txid:t.txid})===meta.paymentId
}

// Pi approval precedes wallet signing; its canonical from_address may still be
// empty. This is only a bounded pretransaction admission, never proof of an
// incoming transfer. Completion and every financial executor retain exact verify.
export async function verifyTestnetApproval(payment:unknown) {
  if(!payment || typeof payment!=='object') return false
  const p=payment as Record<string,unknown>,meta=p.metadata as {paymentId?:unknown}|undefined
  const s=p.status as Record<string,unknown>|undefined
  if(!s || s.cancelled!==false || s.user_cancelled!==false) return false
  // Already-transacted approval retries must retain the original strict verifier.
  if(p.transaction!==null) {
    const t=p.transaction as Record<string,unknown>|undefined
    if(!t || typeof t!=='object' || typeof t.txid!=='string' || !/^[0-9a-f]{64}$/.test(t.txid) ||
      t.verified!==true || s.transaction_verified!==true || s.developer_approved!==true || typeof s.developer_completed!=='boolean') return false
    return verifyTestnetInbound(payment)
  }
  const amountStroops=stroops(p.amount)
  if(p.network!=='Pi Testnet' || p.direction!=='user_to_app' || !amountStroops ||
    typeof p.identifier!=='string' || !p.identifier || typeof meta?.paymentId!=='string' ||
    typeof p.user_uid!=='string' || !p.user_uid || typeof p.from_address!=='string' ||
    (p.from_address!=='' && !/^G[A-Z2-7]{55}$/.test(p.from_address)) ||
    typeof p.to_address!=='string' || !/^G[A-Z2-7]{55}$/.test(p.to_address) ||
    typeof s.developer_approved!=='boolean' || s.transaction_verified!==false || s.developer_completed!==false) return false
  return await invoke('approval',{paymentId:meta.paymentId,payerUid:p.user_uid,
    fromAddress:p.from_address,toAddress:p.to_address,amountStroops})===meta.paymentId
}

// Bootstrap only a fully certified initial preparation. A new executor must
// subsequently obtain the durable selector's scoped right before first send.
export async function admitInitialTestnetPrepared(input:WalletAuthorityClaim, tx?:{unsafe:(sql:string,values:unknown[])=>Promise<unknown[]>}) {
  const policy=process.env.R36_SCOPED_POLICY_DIGEST
  if(!tx || !testnetIngressEnabled() || currentRecoveryRight() || !policy || !/^[0-9a-f]{64}$/.test(policy)) {
    preparedTraceEvent('initial_precondition_rejected',{hasTransaction:!!tx,ingressEnabled:testnetIngressEnabled(),scopedRightPresent:!!currentRecoveryRight(),policyConfigured:!!policy&&/^[0-9a-f]{64}$/.test(policy)});return false
  }
  try {
    const rows=await tx.unsafe('SELECT public.r36_prepare_testnet_ingress($1,$2,$3::text::jsonb) AS admission',
      ['prepared',policy,JSON.stringify(input)])
    const admitted=rows.length===1 && (rows[0] as {admission?:{paymentId?:string}})?.admission?.paymentId===input.paymentId
    preparedTraceEvent(admitted?'initial_sql_admitted':'initial_sql_rejected',{rowCount:rows.length,admissionPresent:rows.length===1&&!!(rows[0] as {admission?:unknown})?.admission})
    return admitted
  } catch(error) {preparedTraceError('initial_sql_exception',error);return false}
}

export async function readOperationSettings():Promise<{mode:'general'|'pilot';maxAmountPi:number}|null>{
 if(!testnetIngressEnabled())return null
 const p=process.env.R36_SCOPED_POLICY_DIGEST
 if(!p||!/^[0-9a-f]{64}$/.test(p))return null
 try{
  const db=await getR36RestrictedClient();if(!db)return null
  const rows=await db.unsafe('SELECT public.r36_operation_settings($1) AS settings',[p])
  const v=rows.length===1?rows[0].settings:null
  if(!v||!['general','pilot'].includes(v.mode)||typeof v.maxAmountStroops!=='string'||! /^[1-9][0-9]{0,13}$/.test(v.maxAmountStroops))return null
  const units=BigInt(v.maxAmountStroops)
  if(units>BigInt('10000000000000'))return null
  return {mode:v.mode,maxAmountPi:Number(units)/10000000}
 }catch{return null}
}
