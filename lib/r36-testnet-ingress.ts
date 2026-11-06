import 'server-only'
import {createHash} from 'node:crypto'
import {currentRecoveryRight} from './r36-recovery-scope'
import type {WalletAuthorityClaim} from './financial-wallet-authority'
import {getR36RestrictedClient} from './db'

export function requiresTestnetIngress() {
  return process.env.VERCEL_ENV === 'production' || process.env.FLASHPAY_RECOVERY_SCOPE === 'admitted_new'
}
export function testnetIngressEnabled() {
  return process.env.FLASHPAY_RECOVERY_SCOPE === 'admitted_new'
}
function stroops(amount:unknown) {
  if(typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 0.20 || Number(amount.toFixed(7)) !== amount) return null
  return String(Math.round(amount * 10000000))
}
async function invoke(action:'reserve'|'bind'|'verify', input:Record<string,string>):Promise<string|null> {
  if(!testnetIngressEnabled()) return null
  const policy=process.env.R36_SCOPED_POLICY_DIGEST
  if(!policy || !/^[0-9a-f]{64}$/.test(policy)) return null
  try {
    const client=await getR36RestrictedClient()
    if(!client) return null
    const rows=await client.unsafe('SELECT public.r36_prepare_testnet_ingress($1,$2,$3::text::jsonb) AS admission',[action,policy,JSON.stringify(input)])
    const id=rows.length===1?rows[0].admission?.paymentId:null
    return typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)?id:null
  } catch { return null }
}
export async function reserveTestnetCreation(input:{paymentId:string;createIntentId:string;merchantUid:string;merchantId:string;amount:number;note:string}) {
  const amountStroops=stroops(input.amount)
  if(!amountStroops) return null
  const {amount,note,...identity}=input
  return invoke('reserve',{...identity,amountStroops,noteDigest:createHash('sha256').update(note).digest('hex')})
}
export async function bindTestnetPayer(paymentId:string,payerUid:string) {
  return await invoke('bind',{paymentId,payerUid}) === paymentId
}
export async function verifyTestnetInbound(payment:unknown) {
  if(!payment || typeof payment!=='object')return false
  const p=payment as Record<string,unknown>,meta=p.metadata as {paymentId?:unknown}|undefined
  const amountStroops=stroops(p.amount)
  if(p.network!=='Pi Testnet' || p.direction!=='user_to_app' || !amountStroops || typeof meta?.paymentId!=='string' ||
    typeof p.user_uid!=='string' || typeof p.from_address!=='string' || typeof p.to_address!=='string')return false
  return await invoke('verify',{paymentId:meta.paymentId,payerUid:p.user_uid,fromAddress:p.from_address,toAddress:p.to_address,amountStroops}) === meta.paymentId
}

// Bootstrap only a fully certified initial preparation. A new executor must
// subsequently obtain the durable selector's scoped right before first send.
export async function admitInitialTestnetPrepared(input:WalletAuthorityClaim, tx?:{unsafe:(sql:string,values:unknown[])=>Promise<unknown[]>}) {
  const policy=process.env.R36_SCOPED_POLICY_DIGEST
  if(!tx || !testnetIngressEnabled() || currentRecoveryRight() || !policy || !/^[0-9a-f]{64}$/.test(policy)) return false
  try {
    const rows=await tx.unsafe('SELECT public.r36_prepare_testnet_ingress($1,$2,$3::text::jsonb) AS admission',
      ['prepared',policy,JSON.stringify(input)])
    return rows.length===1 && (rows[0] as {admission?:{paymentId?:string}})?.admission?.paymentId===input.paymentId
  } catch { return false }
}
