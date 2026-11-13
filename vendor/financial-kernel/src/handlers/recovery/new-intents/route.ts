import {financialNetwork} from '../../../lib/financial-network'
import {deployment} from '../../../deployment'
import { timingSafeEqual } from "node:crypto"
import { after, NextRequest, NextResponse } from "next/server"
import { query } from "../../../lib/db"
import {ensurePrivateTrustHost} from "../../../lib/r36-private-host-wake"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

// The cutover was sampled on the production database. Neither QStash nor an
// event caller can move the boundary. The four holds are defense in depth.
const cutover = deployment().recoveryCutover
const historicalHolds = deployment().historicalHolds

function matches(expected: string | undefined, supplied: string | null) {
  if (!expected || !supplied) return false
  const a = Buffer.from(expected), b = Buffer.from(supplied)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function observe(request: NextRequest, selectedId?:string):Promise<Response> {
  const url = new URL(request.url)
  const subjects = url.searchParams.getAll("paymentId")
  const id = selectedId ?? subjects[0]
  if ([...url.searchParams.keys()].some(k => k !== "paymentId") || subjects.length > 1 ||
      (id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))) {
    return NextResponse.json({ error: "Invalid recovery scope" }, { status: 400 })
  }
  if(id===undefined && process.env.FLASHPAY_RECOVERY_SCOPE==='admitted_new'){
    try{
      const {drainBoundedRecovery}=await import('../../../lib/r36-bounded-recovery')
      const result=await drainBoundedRecovery({query,visit:payment=>observe(request,payment),now:()=>Date.now()})
      console.info('[Recovery bounded work]',{selected:result.selected,processed:result.processed})
      return NextResponse.json(result,{status:result.outcomes.some(x=>x.status>=500)?503:200,headers:{'Cache-Control':'no-store'}})
    }catch{
      return NextResponse.json({error:'Recovery discovery unavailable',financialOutcome:'not_authorized_by_discovery'},{status:503})
    }
  }
  // Poll unfinished work only. A final checkpoint alone is insufficient: a
  // missing finality seal or refund presentation remains recoverable work.
  // This filter grants no authority; original selectors still authorize work.
  const rows = await query(`
    WITH scoped AS (
      SELECT i.payment_id, i.merchant_id, i.merchant_uid, i.customer_amount
      FROM public.payment_create_intents i
      WHERE i.created_at > $1::timestamptz AND i.created_at <= statement_timestamp()
        AND ($2::text IS NULL OR i.payment_id = $2)
        AND encode(sha256(convert_to(i.payment_id,'UTF8')),'hex') <> ALL($3::text[])
        AND NOT EXISTS (
          SELECT 1 FROM public.settlement_checkpoints done
          WHERE done.payment_id=i.payment_id AND done.merchant_id=i.merchant_id
            AND done.merchant_uid=i.merchant_uid AND done.customer_amount=i.customer_amount
            AND done.merchant_amount+done.app_commission=i.customer_amount
            AND done.stage='db_finalized' AND done.pi_completed_at IS NOT NULL
            AND done.db_finalized_at IS NOT NULL AND done.horizon_confirmed_at IS NOT NULL
            AND done.a2u_txid=done.prepared_tx_hash
            AND NOT EXISTS(SELECT 1 FROM public.refund_checkpoints conflict WHERE conflict.payment_id=i.payment_id)
            AND EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals seal
              WHERE seal.network='${financialNetwork()}' AND seal.source_wallet=done.a2u_from_address
                AND seal.owner_payment_id=i.payment_id AND seal.operation_kind='settlement'
                AND seal.owner_operation_id=done.a2u_payment_id AND seal.prepared_tx_hash=done.prepared_tx_hash
                AND seal.prepared_sequence=done.prepared_sequence::text)
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.refund_checkpoints done
          JOIN public.settlement_checkpoints identity ON identity.payment_id=done.payment_id
          WHERE done.payment_id=i.payment_id AND done.status='completed' AND done.stage='audit_recorded'
            AND identity.stage='payment_identity' AND identity.merchant_id=i.merchant_id
            AND identity.merchant_uid=i.merchant_uid AND identity.customer_amount=i.customer_amount
            AND identity.merchant_amount+identity.app_commission=i.customer_amount
            AND done.amount=i.customer_amount AND done.payer_uid=identity.payer_uid
            AND EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals seal
              WHERE seal.network='${financialNetwork()}' AND seal.owner_payment_id=i.payment_id
                AND seal.operation_kind='refund' AND seal.owner_operation_id=done.refund_id
                AND seal.prepared_tx_hash=done.refund_txid)
            AND EXISTS(SELECT 1 FROM public.refund_audit_events proof
              WHERE proof.refund_id=done.refund_id AND proof.payment_id=i.payment_id
                AND proof.idempotency_key=done.idempotency_key
                AND proof.event_type='refund_presentation_proof_recorded')
        )
    ), classified AS (
      SELECT CASE
        WHEN c.payment_id IS NULL OR c.merchant_id IS DISTINCT FROM i.merchant_id OR c.merchant_uid IS DISTINCT FROM i.merchant_uid
          OR c.customer_amount IS DISTINCT FROM i.customer_amount OR (c.merchant_amount+c.app_commission) IS DISTINCT FROM i.customer_amount
          OR i.customer_amount <= 0 OR (r.payment_id IS NOT NULL AND r.amount <> i.customer_amount)
          THEN 'held'
        WHEN r.status = 'manual_review_required' OR r.stage = 'wallet_submission_started'
          OR EXISTS (SELECT 1 FROM public.financial_wallet_submission_attempts a WHERE a.owner_payment_id=i.payment_id)
          THEN 'held'
        WHEN r.payment_id IS NOT NULL AND c.stage <> 'payment_identity' THEN 'held'
        WHEN c.stage='db_finalized' OR r.status='completed' THEN 'terminal_checkpoint'
        ELSE 'pending'
      END AS state,
      ((c.u2a_verified_at IS NOT NULL AND c.stage <> 'db_finalized') OR
       (c.u2a_approval_attempted_at IS NOT NULL AND c.u2a_verified_at IS NULL AND c.stage='payment_identity') OR c.stage='db_finalized' OR
       (r.payment_id IS NOT NULL AND r.status <> 'manual_review_required')) AS evidence_work
      FROM scoped i LEFT JOIN public.settlement_checkpoints c USING (payment_id)
      LEFT JOIN public.refund_checkpoints r USING (payment_id)
    )
    SELECT current_setting('neon.branch_id',true) AS branch,
      count(*) FILTER (WHERE state='held')::int AS held,
      count(*) FILTER (WHERE state='pending')::int AS pending,
      count(*) FILTER (WHERE state='terminal_checkpoint')::int AS terminal,
      count(*) FILTER (WHERE evidence_work)::int AS evidence_work
    FROM classified`, [cutover, id ?? null, historicalHolds])
  const counts = rows?.[0] as {branch?: string; held?: number; pending?: number; terminal?: number;evidence_work?:number} | undefined
  if (rows?.length !== 1 || counts?.branch !== deployment().databaseBranch ||
      ![counts.held, counts.pending, counts.terminal,counts.evidence_work].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) {
    return NextResponse.json({ error: "Recovery observation unavailable" }, { status: 503 })
  }
  const result = { mode: "observe_only", scope: id ? "one" : "since_cutover", held: counts.held,
    pending: counts.pending, terminalCheckpoints: counts.terminal, financialDispatch: false }
  console.info("[Recovery new intents]", {...result,phase:"observation",configuredMode:process.env.FLASHPAY_RECOVERY_SCOPE})
  if (process.env.FLASHPAY_RECOVERY_SCOPE === "admitted_new") {
    try {
      if(Number(counts.held)+Number(counts.pending)+Number(counts.terminal)===0)
        return NextResponse.json({scope:result.scope,mode:"admitted_new",dispatch:"no_unfinished_work",
          executorInvoked:false,financialOutcome:"not_invoked"},{headers:{"Cache-Control":"no-store"}})
      const {resumeAdmittedRecovery} = await import("../../../lib/r36-scoped-recovery")
      // An exact, already spent and independently confirmed right must finish
      // reconciliation even while the certificate producer is rotating. This
      // selector cannot return a prepared/new submission or bypass XOR.
      let dispatch=await resumeAdmittedRecovery(id??null,'confirmed')
      // Operational host readiness is not a financial authority. First ask the
      // SAME SQL selector for this already admitted right; it rechecks current
      // policy, revocation, identity, wallet ownership, XOR and the reservation.
      // The unchanged executor still claims One-Shot at use. Missing authority
      // follows the original host/evidence path below, never a new permission.
      if(dispatch==='no_confirmed_right'){
        const started=performance.now()
        const admitted=await resumeAdmittedRecovery(id??null,'admitted')
        console.info('[R36 READY HANDOFF]',{scope:id?'one':'since_cutover',result:admitted,
          durationMs:Math.round(performance.now()-started)})
        if(admitted!=='no_ready_admitted_right')dispatch=admitted
      }
      // An unissued refund needs its original Pi identity and encrypted XDR
      // candidate BEFORE private-host readiness can require successor evidence.
      // Original preparation only; no signing or funds submission is authorized.
      if(dispatch==='no_confirmed_right'&&Number(counts.evidence_work)>0){
        const {preparePendingRefundEvidence}=await import("../../../lib/r36-scoped-recovery")
        const prepared=await preparePendingRefundEvidence(id??null)
        console.info('[Recovery refund evidence]',{scope:result.scope,result:prepared,fundsSubmission:false})
      }
      // Empty periodic wakes remain cheap. No rights or historical cursor change.
      if(dispatch==='no_confirmed_right'&&Number(counts.evidence_work)>0&&!await ensurePrivateTrustHost('recovery')) {
        // The issuer may be waiting for this original terminal seal. Recording
        // verified completed facts is independent of issuing a new permission;
        // never enter an executor through this readiness-failure branch.
        const {recordAdmittedTerminalSeal}=await import("../../../lib/r36-terminal-seal")
        const policy=process.env.R36_SCOPED_POLICY_DIGEST
        const terminal=policy?await recordAdmittedTerminalSeal(id??null,policy):null
        if(terminal==='terminal_seal_recorded'||terminal==='terminal_presentation_recorded')
          return NextResponse.json({scope:result.scope,mode:"admitted_new",dispatch:terminal,
            executorInvoked:false,financialOutcome:"not_invoked"},{headers:{"Cache-Control":"no-store"}})
        return NextResponse.json({error:'Private evidence service unavailable',dispatch:'evidence_service_held'},{status:503,headers:{'Cache-Control':'no-store'}})
      }
      if(dispatch==='no_confirmed_right')dispatch=await resumeAdmittedRecovery(id??null)
      const invoked = dispatch.endsWith("_invoked") || dispatch === "executor_held"
      const outcome = {scope:result.scope, mode:"admitted_new", dispatch, executorInvoked:invoked,
        financialOutcome:invoked ? "verify_durable_result" : "not_invoked"}
      console.info("[Recovery admitted right]", outcome)
      // The external /complete wake may prepare XDR before the private producer
      // observes it. Notify that existing reader immediately after progress;
      // original SQL/issuer guards still decide whether anything is executable.
      if(['preparation_invoked','inbound_observation_invoked','refund_invoked',
          'refund_finalization_invoked','refund_projection_invoked','terminal_seal_recorded',
          'terminal_presentation_recorded'].includes(dispatch))after(async()=>{
        await ensurePrivateTrustHost('completion')
      })
      if(dispatch==='settlement_invoked')after(async()=>{
        try{
          const {continueConfirmedSettlement,claimConfirmedFollowup}=await import("../../../lib/r36-confirmed-followup")
          const followup=await continueConfirmedSettlement({env:process.env,claim:claimConfirmedFollowup,send:fetch,select:async()=>{
            const unfinished=await query(`SELECT s.payment_id FROM public.settlement_checkpoints s
              JOIN public.payment_create_intents i USING(payment_id)
              WHERE i.created_at>$1::timestamptz AND ($2::text IS NULL OR s.payment_id=$2)
                AND encode(sha256(convert_to(s.payment_id,'UTF8')),'hex')<>ALL($3::text[])
                AND s.stage IN ('horizon_confirmed','pi_completed')
                AND s.horizon_confirmed_at IS NOT NULL AND s.a2u_txid=s.prepared_tx_hash
                AND NOT EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.payment_id=s.payment_id)
              ORDER BY s.horizon_confirmed_at LIMIT 1`,[cutover,id??null,historicalHolds])
            return unfinished?.length===1?String((unfinished[0] as {payment_id:string}).payment_id):null
          }})
          console.info("[Recovery confirmed followup]",{status:followup})
        }catch{console.warn("[Recovery confirmed followup]",{status:"unavailable_original_guards_preserved"})}
      })
      const unavailable = dispatch === "configuration_held" || dispatch === "runtime_held"
      return NextResponse.json(outcome, {status:unavailable ? 503 : 200, headers:{"Cache-Control":"no-store"}})
    } catch (error) {
      const code=error instanceof Error&&/^[A-Z0-9_]{1,96}$/.test(error.message)?error.message:'RECOVERY_DEPENDENCY_UNAVAILABLE'
      console.warn('[Recovery unavailable]',{scope:result.scope,code,financialOutcome:'verify_durable_result'})
      return NextResponse.json({error:"Scoped recovery unavailable"}, {status:503})
    }
  }
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization")
  if (!auth?.startsWith("Bearer ") || !matches(process.env.CRON_SECRET, auth.slice(7)))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  return observe(request)
}

export async function POST(request: NextRequest) {
  if (!matches(process.env.FLASHPAY_TRANSIENT_RECOVERY_SECRET, request.headers.get("x-flashpay-transient-recovery-secret")))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  return observe(request)
}
