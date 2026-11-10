import 'server-only'
import {getR36RestrictedClient} from './db'
import {executeA2URecovery} from './a2u-recovery-service'
import {executeRefundBlockchain,executeRefundFinalProjection} from './refund-executor'
import {runAutomaticRefundPreparationStep,runAutomaticRefundFinalizationStep} from './refund-auto-orchestrator'
import {currentRecoveryRight,runWithRecoveryRight,type ScopedRecoveryRight} from './r36-recovery-scope'
import {reconcileScopedU2ACompletion} from './r36-u2a-completion'
import {recordAdmittedTerminalSeal} from './r36-terminal-seal'
import {observeUnrecordedInbound} from './r36-inbound-observation-recovery'

const settlement = ['prepared','horizon_confirmed','pi_completed']
const refund = ['wallet_submission_started','wallet_submission_confirmed','payment_checkpoint_updated','accounting_recorded','audit_recorded','completed_projection']

// The request may narrow selection to one payment. It can never supply the
// wallet, executor, hash, grant, budget, policy digest or historical cutover.
export async function resumeAdmittedRecovery(subject:string|null,mode:'all'|'confirmed'='all') {
  const policy=process.env.R36_SCOPED_POLICY_DIGEST
  if(process.env.FLASHPAY_RECOVERY_SCOPE!=='admitted_new' || !policy || !/^[0-9a-f]{64}$/.test(policy)) return 'configuration_held'
  const client=await getR36RestrictedClient()
  if(!client) return 'runtime_held'
  // A completed operation needs its immutable finality fact before the private
  // issuer can certify wallet turnover. This GET-only branch grants no right.
  const terminal=mode==='all'?await recordAdmittedTerminalSeal(subject,policy):null
  if(terminal!==null)return terminal
  const rows=mode==='all'?await client.unsafe('SELECT public.r36_reserve_new_recovery($1,$2) AS right',[subject,policy]):[{right:null}]
  if(rows.length!==1) throw Error('R36_SELECTION_UNAVAILABLE')
  let r:ScopedRecoveryRight|null=rows[0].right
  if(r===null) {
    // An expired initial admission cannot authorize another send. An exact
    // already-consumed, Horizon-confirmed right may finish Pi/DB reconciliation.
    const confirmed=await client.unsafe('SELECT public.r36_select_confirmed_settlement_reconciliation($1,$2) AS right',[subject,policy])
    if(confirmed.length!==1)throw Error('R36_CONFIRMED_SELECTION_UNAVAILABLE')
    r=confirmed[0].right
    if(r!==null&&(r.kind!=='settlement'||r.spent!==true||!['horizon_confirmed','pi_completed'].includes(r.stage)))
      throw Error('R36_CONFIRMED_SELECTION_MISMATCH')
  }
  if(r===null) {
    // The initial certificate authorizes one send. After a confirmed refund,
    // its expiry must not strand completion, accounting or receipt projection.
    // This read-only selector requires the exact attempt made while valid and
    // never returns wallet_submission_started or another submission right.
    const confirmed=await client.unsafe('SELECT public.r36_select_confirmed_refund_reconciliation($1,$2) AS right',[subject,policy])
    if(confirmed.length!==1)throw Error('R36_CONFIRMED_REFUND_SELECTION_UNAVAILABLE')
    r=confirmed[0].right
    if(r!==null&&(r.kind!=='refund'||r.spent!==true||!['wallet_submission_confirmed','payment_checkpoint_updated','accounting_recorded','audit_recorded','completed_projection'].includes(r.stage)))
      throw Error('R36_CONFIRMED_REFUND_SELECTION_MISMATCH')
  }
  if(r===null) {
    if(mode==='confirmed')return 'no_confirmed_right'
    // A callback may die after Pi accepted the incoming transaction, before
    // either address binding or verified checkpoint committed. GET-only
    // observation restores that proof; it cannot approve, complete or send.
    if(await observeUnrecordedInbound(subject,policy))return 'inbound_observation_invoked'
    // Initial preparation must precede a certificate/Prepared authority. This
    // branch never receives a submission right: claimFirstWalletSubmission
    // still refuses without the exact committed right below, even after races.
    if(currentRecoveryRight()) return 'executor_held'
    const pending=await client.unsafe('SELECT public.r36_next_testnet_preparation($1,$2) AS candidate',[subject,policy])
    if(pending.length!==1) throw Error('R36_PREPARATION_SELECTION_UNAVAILABLE')
    const candidate=pending[0].candidate as null|{phase:string;id:string;kind:string;op:string;stage:string;piCreated:boolean}
    if(candidate===null) return 'no_admitted_right'
    if(!candidate || !['preparation_only','u2a_completion','certification_recovery'].includes(candidate.phase) ||
      typeof candidate.id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate.id) ||
      (subject!==null&&candidate.id!==subject) || typeof candidate.op!=='string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(candidate.op) ||
      typeof candidate.piCreated!=='boolean' || !['settlement','refund'].includes(candidate.kind) ||
      !(candidate.kind==='settlement'?['payment_identity','a2u_created']:['eligibility_verified','intent_created','wallet_submission_started']).includes(candidate.stage) ||
      (candidate.kind==='settlement'&&(candidate.op!==candidate.id||candidate.piCreated)) ||
      (candidate.kind==='refund'&&candidate.piCreated&&candidate.stage!=='wallet_submission_started') ||
      (['u2a_completion','certification_recovery'].includes(candidate.phase)&&(candidate.kind!=='settlement'||candidate.stage!=='payment_identity'))) throw Error('R36_PREPARATION_SELECTION_MISMATCH')
    if(candidate.phase==='u2a_completion' || (candidate.phase==='certification_recovery' && process.env.VERCEL_ENV==='production')) return reconcileScopedU2ACompletion(candidate.id)
    if(candidate.kind==='settlement') {
      await executeA2URecovery(candidate.id,candidate.id)
    } else if(candidate.piCreated) {
      await executeRefundBlockchain(candidate.op,{paymentId:candidate.id,refundId:candidate.op})
    } else {
      await runAutomaticRefundPreparationStep(candidate.id,candidate.op)
    }
    // Preparation may commit the exact owner after the first selection found
    // none. Re-enter the durable selector once for THIS payment only; never
    // manufacture a right from the candidate or inherit the preparation call.
    // The selector rechecks certificate freshness, revocation, XOR and budget.
    const continuation=await client.unsafe('SELECT public.r36_reserve_new_recovery($1,$2) AS right',[candidate.id,policy])
    if(continuation.length!==1)throw Error('R36_CONTINUATION_SELECTION_UNAVAILABLE')
    r=continuation[0].right
    if(r===null)return 'preparation_invoked'
    subject=candidate.id
  }
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
