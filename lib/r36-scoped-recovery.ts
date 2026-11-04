import 'server-only'
import {getR36RestrictedClient} from './db'
import {executeA2URecovery} from './a2u-recovery-service'
import {executeRefundBlockchain,executeRefundFinalProjection} from './refund-executor'
import {runAutomaticRefundFinalizationStep} from './refund-auto-orchestrator'
import {runWithRecoveryRight,type ScopedRecoveryRight} from './r36-recovery-scope'

const settlement = ['prepared','horizon_confirmed','pi_completed']
const refund = ['wallet_submission_started','wallet_submission_confirmed','payment_checkpoint_updated','accounting_recorded','audit_recorded','completed_projection']

// The request may narrow selection to one payment. It can never supply the
// wallet, executor, hash, grant, budget, policy digest or historical cutover.
export async function resumeAdmittedRecovery(subject:string|null) {
  const policy=process.env.R36_SCOPED_POLICY_DIGEST
  if(process.env.FLASHPAY_RECOVERY_SCOPE!=='admitted_new' || !policy || !/^[0-9a-f]{64}$/.test(policy)) return 'configuration_held'
  const client=await getR36RestrictedClient()
  if(!client) return 'runtime_held'
  const rows=await client.unsafe('SELECT public.r36_reserve_new_recovery($1,$2) AS right',[subject,policy])
  if(rows.length!==1) throw Error('R36_SELECTION_UNAVAILABLE')
  const r:ScopedRecoveryRight|null=rows[0].right
  if(r===null) return 'no_admitted_right'
  if(!r || typeof r!=='object' || ![r.id,r.op,r.wallet,r.hash,r.seq,r.stage].every(v=>typeof v==='string') || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.id) ||
    (subject!==null&&r.id!==subject) || typeof r.spent!=='boolean' || !['settlement','refund'].includes(r.kind) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(r.op) ||
    !/^G[A-Z2-7]{55}$/.test(r.wallet) || !/^[0-9a-f]{64}$/.test(r.hash) || !/^[1-9][0-9]{0,29}$/.test(r.seq) ||
    !(r.kind==='settlement'?settlement:refund).includes(r.stage)) throw Error('R36_SELECTION_MISMATCH')
  return runWithRecoveryRight(r,async()=>{
    // Only this committed prepared owner may use its scheduler identity.
    // Executors retain wallet locks, original finality and atomic first-POST checks.
    if(r.kind==='settlement') {
      const result=await executeA2URecovery(r.id,r.stage==='prepared'?r.id:null)
      return result.status==='manual_review_required'?'executor_held':'settlement_invoked'
    }
    if(r.stage==='completed_projection') {
      const result=await executeRefundFinalProjection(r.op)
      return result.outcome==='found'?'refund_projection_invoked':'executor_held'
    }
    if(r.stage==='wallet_submission_started') {
      const result=await executeRefundBlockchain(r.op,{paymentId:r.id,refundId:r.op})
      return result.outcome==='blocked'?'executor_held':'refund_invoked'
    }
    const result=await runAutomaticRefundFinalizationStep(r.id,r.op)
    return result.state==='blocked'||result.result.outcome!=='success'?'executor_held':'refund_finalization_invoked'
  })
}
