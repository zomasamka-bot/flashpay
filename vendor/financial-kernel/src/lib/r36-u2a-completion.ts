import {financialNetwork} from './financial-network'
import {originalRefundCertificationEnabled} from "./r36-operation-policy"
import 'server-only'
import {getDurableU2AIngressAuthoritative,readDr11RefundCertificationHold,verifySettlementRefundAuthorityExclusion,
  claimSettlementPiMutationAttempt,recordSettlementU2ACompletedCheckpoint,recordDr11RefundCertificationHold} from './db'
import {createDr11RefundAuthorityFromDurableHold} from './refund-checkpoint-store'
import {serverConfig} from './server-config'
import {testnetIngressEnabled,verifyTestnetInbound} from './r36-testnet-ingress'
import {currentRecoveryRight} from './r36-recovery-scope'

// Exact-payment counterpart of original F2-7 rediscovery. It completes only a
// previously verified U2A; it never grants an A2U/Refund submission right.
export async function reconcileScopedU2ACompletion(paymentId:string) {
  if(!testnetIngressEnabled() || currentRecoveryRight() || !serverConfig.piApiKey) return 'executor_held'
  const hold=await readDr11RefundCertificationHold(paymentId)
  const xor=await verifySettlementRefundAuthorityExclusion(paymentId)
  if(hold.outcome==='INDETERMINATE' || xor.outcome!=='CLEAR' || xor.refundActive) return 'executor_held'
  const durable=await getDurableU2AIngressAuthoritative(paymentId)
  if(durable.outcome!=='FOUND') return 'executor_held'
  const d=durable.checkpoint
  // Preserve the original /api/pi/complete production certification contract.
  // A completed U2A alone must never publish a 0.10 Pi settlement candidate.
  const refundCertification=hold.outcome==='HELD' || originalRefundCertificationEnabled(financialNetwork(),d.customerAmount)
  if(hold.outcome==='HELD' && !refundCertification) return 'executor_held'
  if(d.completedAt!==null && !refundCertification) return 'u2a_completion_invoked'
  const record=(x:unknown):Record<string,unknown>|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null
  const endpoint=`https://api.minepi.com/v2/payments/${encodeURIComponent(d.u2aIdentifier)}`
  const exact=async()=>{
    try {
      const response=await fetch(endpoint,{method:'GET',headers:{Authorization:`Key ${serverConfig.piApiKey}`,Accept:'application/json'},
        cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000)})
      if(!response.ok) return null
      const p=record(await response.json()),s=record(p?.status),t=record(p?.transaction),m=record(p?.metadata)
      if(!p||!s||!t||p.network!==financialNetwork()||p.direction!=='user_to_app'||p.identifier!==d.u2aIdentifier||
        p.amount!==d.customerAmount||p.user_uid!==d.payerUid||m?.paymentId!==paymentId||t.txid!==d.u2aTxid||t.verified!==true||
        s.developer_approved!==true||s.transaction_verified!==true||s.cancelled===true||s.user_cancelled===true||
        !await verifyTestnetInbound(p)) return null
      return s
    } catch { return null }
  }
  let state=await exact()
  if(!state) return 'executor_held'
  if(state.developer_completed!==true) {
    const attempt=await claimSettlementPiMutationAttempt({kind:'u2a_complete',paymentId,externalPaymentId:d.u2aIdentifier,txid:d.u2aTxid})
    // The durable original claim, not a timeout or a 404, is the only POST permission.
    if(attempt.outcome!=='RECORDED') return 'executor_held'
    try {
      await fetch(endpoint+'/complete',{method:'POST',headers:{Authorization:`Key ${serverConfig.piApiKey}`,'Content-Type':'application/json'},
        body:JSON.stringify({txid:d.u2aTxid}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000)})
    } catch { /* Ambiguous response: read only. Never reset or repeat the claim. */ }
    state=await exact()
    if(!state || state.developer_completed!==true) return 'executor_held'
  }
  if(refundCertification) {
    const held=await recordDr11RefundCertificationHold({paymentId,merchantId:d.merchantId,merchantUid:d.merchantUid,customerAmount:d.customerAmount})
    if(held.outcome!=='RECORDED' && held.outcome!=='REPLAYED') return 'executor_held'
  }
  const result=await recordSettlementU2ACompletedCheckpoint({paymentId,merchantId:d.merchantId,merchantUid:d.merchantUid,
    customerAmount:d.customerAmount,u2aIdentifier:d.u2aIdentifier,u2aTxid:d.u2aTxid,payerUid:d.payerUid})
  if(result.outcome!=='RECORDED' && result.outcome!=='REPLAYED') return 'executor_held'
  if(refundCertification) {
    const refund=await createDr11RefundAuthorityFromDurableHold(paymentId)
    if(!refund || refund.paymentId!==paymentId || refund.payerUid!==d.payerUid || refund.amount!==0.1 ||
      refund.idempotencyKey!==`dr11-live:${paymentId}`) return 'executor_held'
  }
  return 'u2a_completion_invoked'
}
