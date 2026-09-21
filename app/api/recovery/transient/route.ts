import { randomUUID, timingSafeEqual } from "crypto"
import { after, type NextRequest, NextResponse } from "next/server"

import { redis, isRedisConfigured } from "@/lib/redis"
import { executeA2URecovery } from "@/lib/a2u-recovery-service"
import { isStage1OnlySettlementDispatchCandidate } from "@/lib/a2u-locked-executor"
import { ensureAutomaticRefundIntent, readAutomaticRefundDrainHead, runAutomaticRefundPass, runAutomaticRefundPreparationStep, runAutomaticRefundFinalizationStep } from "@/lib/refund-auto-orchestrator"
import { logF27RefundCheckpointDiagnostic } from "@/lib/refund-checkpoint-store"
import { query, listOutstandingSettlementCheckpointIds, getSettlementCheckpointAuthoritative, listRecoverableU2AIngressCheckpointIds, getDurableU2AIngressAuthoritative, recordSettlementU2ACompletedCheckpoint, verifySettlementRefundAuthorityExclusion, repairF1LegacyCompletedCanonicalReceipts } from "@/lib/db"
import { isRefundEligible as checkRefundEligibility } from "@/lib/types"
import { reconcileIncompleteA2UPayment } from "@/lib/pi-reconciliation"
import { isPaymentFinal } from "@/lib/payment-status"
import { compareAndSwapPaymentProjection } from "@/lib/payment-projection-cas"
import { serverConfig } from "@/lib/server-config"
import { maybeInjectF27Fault } from "@/lib/f2-7-fault-injection"
import type { Payment } from "@/lib/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_ATTEMPTS = 5
const BOUNDED_PIPELINE_CONCURRENCY = 2
const WALLET_DRAIN_BURST_LIMIT: number | null = null
const WALLET_DRAIN_BURST_BUDGET_MS = 60_000
const IMMEDIATE_DRAIN_KICK_KEY = "flashpay:settlement:immediate-drain-kick:v1"
const READY_SEQUENCE_KEY = "flashpay:settlement:ready:v1:sequence"
const READY_BASELINE_SCAN_SEEN_KEY = "flashpay:settlement:ready:v1:authority-baseline-scan-seen"
const READY_BASELINE_COVERAGE_KEY = "flashpay:settlement:ready:v1:authority-baseline-coverage"
const CONTINUATION_MODE = "continuation-kick"
const IMMEDIATE_DRAIN_MODE = "immediate-drain"
const RECOVERY_SECRET_ENV = "FLASHPAY_TRANSIENT_RECOVERY_SECRET"
const runtimeEnv = process.env
const DRAIN_LEASE_KEY = "flashpay:recovery:transient:drain-lease:v1"
const DRAIN_LEASE_TTL_SECONDS = 900
const PI_CREATE_BACKPRESSURE_KEY = "flashpay:recovery:pi-create-backpressure:v1"
const RECOVERY_WAKE_HEALTH_KEY = "flashpay:operations:recovery-last-wake:v1"
const F1_BALANCE_DIAGNOSTIC_ONCE_KEY = "flashpay:diagnostic:f1-balance-integrity:v1:ec3295"
const F1_FORENSIC_ATTRIBUTION_ONCE_KEY = "flashpay:diagnostic:f1-forensic-attribution:v1:fa1f5"
const F1_ROOT_CAUSE_CERT_ONCE_KEY = "flashpay:diagnostic:f1-root-cause-cert:v1:8f4a22"
const F1_GUARDED_REPAIR_ONCE_KEY = "flashpay:repair:f1-legacy-completed:v1:d6d1d6"
const F1_FINAL_LEGACY_CLOSURE_ONCE_KEY = "flashpay:repair:f1-final-legacy-closure:v1:0594908"
const F1_ORPHAN_FORENSIC_PROOF_ONCE_KEY = "flashpay:diagnostic:f1-orphan-forensic-proof:v1:d1a0ae"
const F1_FINAL_ACCOUNTING_CERT_ONCE_KEY = "flashpay:diagnostic:f1-final-accounting-cert:v1:d2823a"
const PI_CREATE_BACKPRESSURE_FALLBACK_MS = 15 * 60_000
const DRAIN_LEASE_RELEASE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`
const DRAIN_LEASE_RENEW_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current ~= ARGV[1] then return 0 end
return redis.call("EXPIRE", KEYS[1], ARGV[2])
`

type DurableU2AIngressRepopulation = {
  scanned:number
  repopulated:number
  healed:number
  indexed:number
  deferredNoAccessToken:number
  verifiedOnly:number
  piCompletionReconciled:number
  piReadUncertain:number
  conflicts:number
}

/**
 * F2-3: PostgreSQL-driven rediscovery for pre-A2U U2A ingress.
 *
 * This function never creates Settlement/Refund blockchain movement. It can
 * restore a missing Redis projection from exact durable U2A identity. F2-4 lets
 * a fully reconstructed accessToken="" projection regain ready membership; the
 * locked executor still must prove exact PostgreSQL + Pi server authority before
 * any A2U creation is allowed.
 */
async function repopulateDurableU2AIngressWork():Promise<DurableU2AIngressRepopulation>{
  const page=await listRecoverableU2AIngressCheckpointIds(200)
  if(page.outcome!=='FOUND')throw new Error(page.error)
  const result:DurableU2AIngressRepopulation={scanned:page.paymentIds.length,repopulated:0,healed:0,indexed:0,deferredNoAccessToken:0,verifiedOnly:0,piCompletionReconciled:0,piReadUncertain:0,conflicts:0}
  for(const paymentId of page.paymentIds){
    const authority=await verifySettlementRefundAuthorityExclusion(paymentId)
    if(authority.outcome!=='CLEAR'||authority.refundActive){result.conflicts++;continue}
    let durable=await getDurableU2AIngressAuthoritative(paymentId)
    if(durable.outcome==='ABSENT')continue // It may have advanced to the existing Stage1+ recovery lane concurrently.
    if(durable.outcome!=='FOUND')throw new Error(durable.error)

    // F2-7 closes both U2A crash windows from durable exact identity. The worker
    // may call Pi /complete only after GET-proving the exact durable payment/txid,
    // then it refetches and trusts only Pi's resulting developer_completed state.
    if(durable.checkpoint.completedAt===null){
      const ingress=durable.checkpoint
      if(!serverConfig.piApiKey){result.piReadUncertain++;continue}
      const readExactPiU2A=async():Promise<{dto:Record<string,unknown>;status:Record<string,unknown>;transaction:Record<string,unknown>}|null>=>{
        let response:Response
        try{
          response=await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(ingress.u2aIdentifier)}`,{
            method:'GET',headers:{Authorization:`Key ${serverConfig.piApiKey}`,Accept:'application/json'},cache:'no-store',redirect:'error',
          })
        }catch{return null}
        if(!response.ok)return null
        const dto=asRecord(await response.json().catch(()=>null)),status=dto?asRecord(dto.status):null,transaction=dto?asRecord(dto.transaction):null,metadata=dto?asRecord(dto.metadata):null
        const payerUid=dto&&typeof dto.user_uid==='string'&&dto.user_uid.trim()!==''&&dto.user_uid===dto.user_uid.trim()?dto.user_uid:''
        if(!dto||!status||!transaction||dto.identifier!==ingress.u2aIdentifier||dto.direction!=='user_to_app'||Number(dto.amount)!==ingress.customerAmount||
          metadata?.paymentId!==paymentId||transaction.txid!==ingress.u2aTxid||transaction.verified!==true||payerUid!==ingress.payerUid||
          status.developer_approved!==true||status.transaction_verified!==true||status.cancelled===true||status.user_cancelled===true)return null
        return{dto,status,transaction}
      }
      let pi=await readExactPiU2A()
      if(!pi){result.piReadUncertain++;continue}
      if(pi.status.developer_completed!==true){
        if(await maybeInjectF27Fault({lane:'settlement',point:'u2a_verified_before_pi_complete',paymentId,merchantId:ingress.merchantId,merchantUid:ingress.merchantUid,amount:ingress.customerAmount,details:{recovery:true}})){
          result.verifiedOnly++;continue
        }
        try{
          await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(ingress.u2aIdentifier)}/complete`,{
            method:'POST',headers:{Authorization:`Key ${serverConfig.piApiKey}`,'Content-Type':'application/json'},body:JSON.stringify({txid:ingress.u2aTxid}),cache:'no-store',redirect:'error',
          })
        }catch{}
        // A lost/non-2xx response is never treated as truth; refetch exact Pi state.
        pi=await readExactPiU2A()
        if(!pi||pi.status.developer_completed!==true){result.piReadUncertain++;continue}
      }
      if(await maybeInjectF27Fault({lane:'settlement',point:'pi_complete_before_u2a_completed',paymentId,merchantId:ingress.merchantId,merchantUid:ingress.merchantUid,amount:ingress.customerAmount,details:{recovery:true,developerCompleted:true}}))continue
      const completion=await recordSettlementU2ACompletedCheckpoint({
        paymentId,merchantId:ingress.merchantId,merchantUid:ingress.merchantUid,customerAmount:ingress.customerAmount,
        u2aIdentifier:ingress.u2aIdentifier,u2aTxid:ingress.u2aTxid,payerUid:ingress.payerUid,
      })
      if(completion.outcome!=='RECORDED'&&completion.outcome!=='REPLAYED'){result.conflicts++;continue}
      if(await maybeInjectF27Fault({lane:'settlement',point:'u2a_completed_before_redis_projection',paymentId,merchantId:ingress.merchantId,merchantUid:ingress.merchantUid,amount:ingress.customerAmount,details:{recovery:true,durableVersion:completion.version}}))continue
      result.piCompletionReconciled++
      durable=await getDurableU2AIngressAuthoritative(paymentId)
      if(durable.outcome!=='FOUND'||durable.checkpoint.completedAt===null){result.conflicts++;continue}
    }

    const d=durable.checkpoint
    let existing=parsePayment(await redis.get(`payment:${paymentId}`))

    if(existing&&(existing.status==='settlement_pending'||existing.status==='settled_to_merchant'||existing.a2uPaymentId!==undefined||existing.a2uTxid!==undefined||existing.a2uPreparedEnvelopeXdr!==undefined||existing.a2uPreparedTxHash!==undefined||existing.a2uPreparedSequence!==undefined||existing.horizonSuccessFlag===true||existing.piCompletionPending===true||existing.piCompleted===true||existing.requiresDbReconciliation===true||existing.dbRecorded===true)){
      const advanced=await getSettlementCheckpointAuthoritative(paymentId)
      if(advanced.outcome==='FOUND')continue
      result.conflicts++
      continue
    }

    if(existing){
      const healed=await redis.eval<[string,string,string,string,string,string,string,string,string],number>(`
local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local ok,current=pcall(cjson.decode,raw); if not ok or type(current)~='table' then return -1 end
local amount=tonumber(ARGV[4]); if not amount then return -1 end
if current.id~=ARGV[1] or current.merchantId~=ARGV[2] or current.merchantUid~=ARGV[3] or current.amount~=amount then return -1 end
if current.customerAmount~=nil and current.customerAmount~=amount then return -1 end
if current.piPaymentId~=nil and current.piPaymentId~=ARGV[5] then return -1 end
if current.u2aTxid~=nil and current.u2aTxid~=ARGV[6] then return -1 end
if current.payerUid~=nil and current.payerUid~=ARGV[7] then return -1 end
if current.status~='pending' and current.status~='paid_to_app' then return -1 end
if current.a2uPaymentId~=nil or current.a2uTxid~=nil or current.a2uPreparedEnvelopeXdr~=nil or current.a2uPreparedTxHash~=nil or current.a2uPreparedSequence~=nil then return -1 end
if current.horizonSuccessFlag==true or current.piCompletionPending==true or current.piCompleted==true or current.requiresDbReconciliation==true or current.dbRecorded==true then return -1 end
if current.refundPaymentId~=nil or current.refundTxid~=nil or current.refundProof~=nil or current.refundStatus~=nil then return -1 end
local projectionVersion=current.redisProjectionVersion; if projectionVersion==nil then projectionVersion=0 end
if type(projectionVersion)~='number' or projectionVersion<0 or projectionVersion~=math.floor(projectionVersion) then return -1 end
current.customerAmount=amount; current.piPaymentId=ARGV[5]; current.u2aTxid=ARGV[6]; current.payerUid=ARGV[7]; current.payerUidSource='verified_u2a'
if current.payerUidCapturedAt==nil then current.payerUidCapturedAt=ARGV[8] end
if ARGV[9]~='' then current.status='paid_to_app'; if current.paidAt==nil then current.paidAt=ARGV[9] end; if current.settlementDispatchRequestedAt==nil then current.settlementDispatchRequestedAt=current.paidAt end end
current.redisProjectionVersion=projectionVersion+1
redis.call('SET',KEYS[1],cjson.encode(current)); return 1
`,[`payment:${paymentId}`],[paymentId,d.merchantId,d.merchantUid,String(d.customerAmount),d.u2aIdentifier,d.u2aTxid,d.payerUid,d.verifiedAt,d.completedAt??''])
      if(healed!==1){result.conflicts++;continue}
      result.healed++
    }else{
      const projection:Payment={
        id:d.paymentId,merchantId:d.merchantId,merchantUid:d.merchantUid,accessToken:'',redisProjectionVersion:1,amount:d.customerAmount,customerAmount:d.customerAmount,
        note:'',status:d.completedAt?'paid_to_app':'pending',createdAt:d.createdAt,piPaymentId:d.u2aIdentifier,u2aTxid:d.u2aTxid,
        payerUid:d.payerUid,payerUidSource:'verified_u2a',payerUidCapturedAt:d.verifiedAt,
        ...(d.completedAt?{paidAt:d.completedAt,settlementDispatchRequestedAt:d.completedAt}:{}),
      }
      const created=await redis.set(`payment:${paymentId}`,JSON.stringify(projection),{nx:true})
      if(created==='OK')result.repopulated++
    }

    const readback=parsePayment(await redis.get(`payment:${paymentId}`))
    if(!readback||readback.id!==paymentId||readback.merchantId!==d.merchantId||readback.merchantUid!==d.merchantUid||readback.amount!==d.customerAmount||
      readback.customerAmount!==d.customerAmount||readback.piPaymentId!==d.u2aIdentifier||readback.u2aTxid!==d.u2aTxid||readback.payerUid!==d.payerUid||readback.payerUidSource!=='verified_u2a'){
      result.conflicts++;continue
    }
    if(!d.completedAt){result.verifiedOnly++;continue}

    // No new financial authority is invented here. Only an already executable
    // original Redis projection may regain lost active/ready membership.
    if(isFreshSettlementDispatchCandidate(readback,Date.now())){
      const indexed=await redis.eval<[string],number>(`
local id=ARGV[1]
redis.call('SADD',KEYS[1],id)
if redis.call('ZSCORE',KEYS[2],id) then return 1 end
local sequence=redis.call('GET',KEYS[3])
if not sequence then
  local top=redis.call('ZRANGE',KEYS[2],-1,-1,'WITHSCORES')
  if #top~=0 and #top~=2 then return -1 end
  local base=0
  if #top==2 then base=tonumber(top[2]); if not base or base<0 or base~=math.floor(base) then return -1 end end
  redis.call('SET',KEYS[3],base)
end
local nextSequence=redis.call('INCR',KEYS[3])
redis.call('ZADD',KEYS[2],'NX',nextSequence,id)
return 2
`,['flashpay:recovery:active-payments:v1','flashpay:settlement:ready:v1',READY_SEQUENCE_KEY],[paymentId])
      if(indexed!==1&&indexed!==2)throw new Error('F2-3 ready index reconstruction unavailable')
      result.indexed++
    }else{
      // Not a canonical fresh-dispatch projection. No financial authority is
      // inferred here; leave it discoverable but unscheduled.
      result.deferredNoAccessToken++
    }
  }
  return result
}

async function repopulateDurableSettlementWork():Promise<{repopulated:number;conflicts:number}>{
  const page=await listOutstandingSettlementCheckpointIds(200)
  if(page.outcome!=='FOUND')throw new Error(page.error)
  let repopulated=0,conflicts=0
  for(const paymentId of page.paymentIds){
    const authority=await verifySettlementRefundAuthorityExclusion(paymentId)
    if(authority.outcome!=='CLEAR'||authority.refundActive){conflicts++;continue}
    const durable=await getSettlementCheckpointAuthoritative(paymentId)
    if(durable.outcome!=='FOUND')throw new Error('Durable Settlement projection unavailable')
    const d=durable.checkpoint
    const dbDone=d.stage==='db_finalized'
    const moved=d.stage==='horizon_confirmed'||d.stage==='pi_completed'||dbDone
    const piDone=d.stage==='pi_completed'||dbDone
    const prepared=d.stage!=='a2u_created'
    const terminalProjection:Payment={id:d.paymentId,merchantId:d.merchantId,merchantUid:d.merchantUid,accessToken:'',redisProjectionVersion:1,amount:d.customerAmount,customerAmount:d.customerAmount,merchantAmount:d.merchantAmount,note:'',status:dbDone?'settled_to_merchant':moved||prepared?'settlement_pending':'paid_to_app',createdAt:new Date(0).toISOString(),piPaymentId:d.u2aIdentifier,u2aTxid:d.u2aTxid,a2uPaymentId:d.a2uPaymentId,a2uFromAddress:d.a2uFromAddress,a2uToAddress:d.a2uToAddress,settlementFailureState:'none',appCommission:0,...(prepared?{a2uPreparedEnvelopeXdr:d.preparedEnvelopeXdr,a2uPreparedTxHash:d.preparedTxHash,a2uPreparedSequence:d.preparedSequence}:{}),...(moved?{a2uTxid:d.a2uTxid,horizonSuccessFlag:true,horizonFeeCharged:d.horizonFeeStroops!/10_000_000,appNetImpact:d.customerAmount-d.merchantAmount-d.horizonFeeStroops!/10_000_000,piCompletionPending:false,piCompleted:true,requiresDbReconciliation:!dbDone,dbRecorded:dbDone}:{})}
    const rawExisting=await redis.get(`payment:${paymentId}`)
    const existing=parsePayment(rawExisting)
    if(dbDone){
      if(existing){
        if(existing.id!==d.paymentId||existing.merchantId!==d.merchantId||existing.merchantUid!==d.merchantUid||existing.piPaymentId!==d.u2aIdentifier||existing.u2aTxid!==d.u2aTxid||existing.a2uPaymentId!==d.a2uPaymentId||existing.a2uTxid!==d.a2uTxid||existing.refundPaymentId!==undefined||existing.refundTxid!==undefined){conflicts++;continue}
        if(existing.status!=='settled_to_merchant'||existing.dbRecorded!==true||existing.requiresDbReconciliation===true){
          const next:Payment={...existing,...terminalProjection,accessToken:existing.accessToken,createdAt:existing.createdAt,redisProjectionVersion:existing.redisProjectionVersion,settledAt:existing.settledAt??new Date().toISOString()}
          const cas=await compareAndSwapPaymentProjection(paymentId,existing,next)
          if(cas.outcome!=='UPDATED'&&!(cas.outcome==='CONFLICT'&&cas.current?.status==='settled_to_merchant'&&cas.current.dbRecorded===true)){conflicts++;continue}
        }
      }else{
        const created=await redis.set(`payment:${paymentId}`,JSON.stringify({...terminalProjection,settledAt:new Date().toISOString()}),{nx:true})
        if(created==='OK')repopulated++
        const readback=parsePayment(await redis.get(`payment:${paymentId}`))
        if(!readback||readback.status!=='settled_to_merchant'||readback.dbRecorded!==true||readback.a2uTxid!==d.a2uTxid){conflicts++;continue}
      }
      await redis.eval<[string],number>("redis.call('SREM',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1]); return 1",['flashpay:recovery:active-payments:v1','flashpay:settlement:ready:v1'],[paymentId])
      continue
    }
    if(existing){await redis.sadd('flashpay:recovery:active-payments:v1',paymentId);continue}
    const created=await redis.set(`payment:${paymentId}`,JSON.stringify(terminalProjection),{nx:true})
    if(created==='OK')repopulated++
    await redis.sadd('flashpay:recovery:active-payments:v1',paymentId)
    const parsed=parsePayment(await redis.get(`payment:${paymentId}`))
    if(!parsed||parsed.id!==paymentId||parsed.a2uPaymentId!==d.a2uPaymentId)throw new Error('Durable Settlement repopulation readback failed')
    const seq=await redis.incr(READY_SEQUENCE_KEY)
    if(!Number.isSafeInteger(seq)||seq<1)throw new Error('Settlement ready sequence unavailable')
    await redis.zadd('flashpay:settlement:ready:v1',{score:seq,member:paymentId})
  }
  return{repopulated,conflicts}
}

type DrainLease = {
  state: "acquired"
  renew: () => Promise<boolean>
  release: () => Promise<boolean>
} | { state: "busy" } | { state: "unavailable" }

type BoundedPipelineTaskResult<T> = { value?: T; stop?: boolean }
type RecoveryPipelineValue = { paymentId: string; ok: boolean; status?: string; error?: string }
type WalletDrainFairnessClass = "fresh" | "reconciling" | "refund"
type WalletDrainLane = "prepared" | WalletDrainFairnessClass

const WALLET_DRAIN_FAIRNESS_ORDER: readonly WalletDrainFairnessClass[] = ["fresh", "reconciling", "refund"]

function walletDrainFairnessClassForGeneration(generation: number | null): WalletDrainFairnessClass | null {
  if (generation === null || !Number.isSafeInteger(generation) || generation < 1) return null
  return WALLET_DRAIN_FAIRNESS_ORDER[(generation - 1) % WALLET_DRAIN_FAIRNESS_ORDER.length]
}

async function runBoundedOrderedPipeline<T>(items: string[], handler: (id: string) => Promise<BoundedPipelineTaskResult<T>>): Promise<{ values: T[]; peakInFlight: number }> {
  if (items.length === 0) return { values: [], peakInFlight: 0 }

  const ordered: Array<T | undefined> = new Array(items.length)
  let nextIndex = 0
  let stopped = false
  let inFlight = 0
  let peakInFlight = 0

  const runWorker = async () => {
    while (true) {
      if (stopped) return
      const index = nextIndex
      if (index >= items.length) return
      nextIndex++
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      try {
        const result = await handler(items[index])
        if (result.value !== undefined) ordered[index] = result.value
        if (result.stop === true) stopped = true
      } finally {
        inFlight--
      }
    }
  }

  const workers: Promise<void>[] = []
  const workerCount = Math.min(BOUNDED_PIPELINE_CONCURRENCY, items.length)
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) workers.push(runWorker())
  const outcomes = await Promise.allSettled(workers)
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason

  const values: T[] = []
  for (const value of ordered) if (value !== undefined) values.push(value)
  return { values, peakInFlight }
}

type PiCreateBackpressureState =
  | { state: "inactive" }
  | { state: "active"; untilMs: number }
  | { state: "unavailable" }

async function readPiCreateBackpressure(now: number): Promise<PiCreateBackpressureState> {
  try {
    const value = await redis.get<unknown>(PI_CREATE_BACKPRESSURE_KEY)
    if (value === null) return { state: "inactive" }
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return { state: "unavailable" }
    const untilMs = Number(value)
    if (!Number.isSafeInteger(untilMs) || untilMs < 0) return { state: "unavailable" }
    return untilMs > now ? { state: "active", untilMs } : { state: "inactive" }
  } catch {
    return { state: "unavailable" }
  }
}

async function extendPiCreateBackpressure(nextRetryAt: string | undefined, now: number): Promise<number | null> {
  const parsedRetryAt = typeof nextRetryAt === "string" && nextRetryAt.trim() !== "" && nextRetryAt === nextRetryAt.trim() ? Date.parse(nextRetryAt) : NaN
  const candidateUntilMs = Math.max(now + PI_CREATE_BACKPRESSURE_FALLBACK_MS, Number.isFinite(parsedRetryAt) && parsedRetryAt > now ? parsedRetryAt : 0)
  try {
    const result = await redis.eval<[string, string], number>(`
local candidate=tonumber(ARGV[1])
local now=tonumber(ARGV[2])
if not candidate or not now or candidate <= now then return -1 end
local current=redis.call("GET",KEYS[1])
if current then
  local currentNumber=tonumber(current)
  if not currentNumber then return -1 end
  if currentNumber > candidate then candidate=currentNumber end
end
local ttl=math.ceil((candidate-now)/1000)
if ttl < 1 then ttl=1 end
redis.call("SET",KEYS[1],tostring(candidate),"EX",ttl)
return candidate
`, [PI_CREATE_BACKPRESSURE_KEY], [String(candidateUntilMs), String(now)])
    return Number.isSafeInteger(result) && result > now ? result : null
  } catch {
    return null
  }
}

function isPiCreateBackpressureSignal(payment: Payment): boolean {
  return payment.a2uErrorCode === "too_many_payments" || payment.a2uErrorCode === "uid_verification_429"
}

async function acquireTransientDrainLease(): Promise<DrainLease> {
  const token = randomUUID()
  try {
    const acquired = await redis.set(DRAIN_LEASE_KEY, token, { nx: true, ex: DRAIN_LEASE_TTL_SECONDS })
    if (acquired !== "OK") return { state: "busy" }
  } catch {
    return { state: "unavailable" }
  }

  let released = false
  return {
    state: "acquired",
    renew: async () => {
      if (released) return false
      try {
        const result = await redis.eval<[string, string], number>(DRAIN_LEASE_RENEW_SCRIPT, [DRAIN_LEASE_KEY], [token, String(DRAIN_LEASE_TTL_SECONDS)])
        return result === 1
      } catch {
        return false
      }
    },
    release: async () => {
      if (released) return true
      released = true
      try {
        const result = await redis.eval<[string], number>(DRAIN_LEASE_RELEASE_SCRIPT, [DRAIN_LEASE_KEY], [token])
        return result === 1
      } catch {
        return false
      }
    },
  }
}

function hasValidSecret(request: NextRequest): boolean {
  const expected = runtimeEnv[RECOVERY_SECRET_ENV]
  const provided = request.headers.get("x-flashpay-transient-recovery-secret")

  if (!expected || !provided) return false

  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)
  if (expectedBuffer.length !== providedBuffer.length) return false

  return timingSafeEqual(expectedBuffer, providedBuffer)
}

function scheduleTrustedTransientRequest(target: "drain" | "continuation-kick"): boolean {
  const recoverySecret = runtimeEnv[RECOVERY_SECRET_ENV]
  const productionHost = runtimeEnv.VERCEL_PROJECT_PRODUCTION_URL || runtimeEnv.VERCEL_URL
  if (runtimeEnv.VERCEL_ENV !== "production" || !recoverySecret || !productionHost || !/^[A-Za-z0-9.-]+$/.test(productionHost)) return false
  try {
    after(async () => {
      try {
        const url = new URL("/api/recovery/transient", `https://${productionHost}`)
        if (target === "continuation-kick") url.searchParams.set("mode", CONTINUATION_MODE)
        else url.searchParams.set("mode", IMMEDIATE_DRAIN_MODE)
        const response = await fetch(url.toString(), {
          method: "POST",
          headers: { "x-flashpay-transient-recovery-secret": recoverySecret },
          cache: "no-store",
          redirect: "error",
        })
        if (!response.ok) console.warn("[P7J12D CONTINUATION] transient request returned non-OK", { target, status: response.status })
      } catch (error) {
        console.warn("[P7J12D CONTINUATION] transient request failed", { target, error: error instanceof Error ? error.message : String(error) })
      }
    })
    return true
  } catch (error) {
    console.warn("[P7J12D CONTINUATION] scheduling failed", { target, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

function parsePayment(value: unknown): Payment | null {
  if (!value) return null
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value
    return parsed && typeof parsed === "object" ? (parsed as Payment) : null
  } catch {
    return null
  }
}

function hasExcludedState(payment: Payment): boolean {
  return (
    payment.settlementFailureState === "held" ||
    payment.settlementFailureState === "manual_review_required" ||
    payment.settlementFailureState === "refund_pending" ||
    payment.settlementFailureState === "refunded" ||
    payment.refundStatus === "pending" ||
    payment.refundStatus === "submitted" ||
    payment.refundStatus === "completed" ||
    payment.refundStatus === "manual_review_required"
  )
}

function isReadyIndexTerminalEgressCandidate(payment: Payment): boolean {
  if (isPaymentFinal(payment)) return true
  return payment.status === "paid_to_app" && payment.settlementFailureState === "held" && payment.refundStatus === "manual_review_required"
}

function isReadyIndexReadyOnlyEgressCandidate(payment: Payment): boolean {
  if (payment.status === "pending" || payment.status === "failed" || payment.status === "cancelled" || payment.status === "settlement_failed" || payment.status === "refund_pending" || payment.status === "refunded") return true
  return (payment.status === "paid_to_app" || payment.status === "settlement_pending") && hasExcludedState(payment)
}

function readyOtherDiagnosticFingerprint(payment: Payment): string {
  const status = (() => {
    switch (payment.status as unknown) {
      case "pending":
      case "paid_to_app":
      case "settlement_pending":
      case "settled_to_merchant":
      case "settlement_failed":
      case "failed":
      case "cancelled":
      case "refund_pending":
      case "refunded":
        return payment.status
      default:
        return "unknown"
    }
  })()
  const failure = (() => {
    switch (payment.settlementFailureState as unknown) {
      case undefined:
        return "unset"
      case "none":
      case "retryable":
      case "reconciling":
      case "held":
      case "manual_review_required":
      case "refund_pending":
      case "refunded":
        return payment.settlementFailureState
      default:
        return "unknown"
    }
  })()
  const refund = (() => {
    switch (payment.refundStatus as unknown) {
      case undefined:
        return "unset"
      case "not_started":
      case "pending":
      case "submitted":
      case "completed":
      case "failed":
      case "manual_review_required":
        return payment.refundStatus
      default:
        return "unknown"
    }
  })()
  const prepared = payment.a2uPreparedEnvelopeXdr !== undefined || payment.a2uPreparedTxHash !== undefined || payment.a2uPreparedSequence !== undefined
  const refundEvidence = payment.refundPaymentId !== undefined || payment.refundTxid !== undefined || payment.refundProof !== undefined
  return [
    `status=${status}`,
    `failure=${failure}`,
    `refund=${refund}`,
    `a2uPayment=${payment.a2uPaymentId !== undefined ? 1 : 0}`,
    `a2uTxid=${payment.a2uTxid !== undefined ? 1 : 0}`,
    `prepared=${prepared ? 1 : 0}`,
    `horizon=${payment.horizonSuccessFlag === true ? 1 : 0}`,
    `piPending=${payment.piCompletionPending === true ? 1 : 0}`,
    `piCompleted=${payment.piCompleted === true ? 1 : 0}`,
    `dbRequired=${payment.requiresDbReconciliation === true ? 1 : 0}`,
    `dbRecorded=${payment.dbRecorded === true ? 1 : 0}`,
    `refundEligible=${payment.payerRefundEligible === true ? 1 : 0}`,
    `refundEvidence=${refundEvidence ? 1 : 0}`,
  ].join("|")
}


function hasSettlementMerchantProjectionAuthority(payment: Payment): boolean {
  if (typeof payment.accessToken !== "string") return false
  // Non-empty token = normal authenticated projection. Empty string is the exact
  // F2-3 total-Redis-loss placeholder and is only executable after F2-4 durable
  // PostgreSQL + Pi proof inside the shared payment-operation lock.
  return payment.accessToken === "" || (payment.accessToken.trim() !== "" && payment.accessToken === payment.accessToken.trim())
}

function readyOtherFreshPrerequisiteFingerprint(payment: Payment, now: number): string {
  const missing: string[] = []
  const dispatchAt = typeof payment.settlementDispatchRequestedAt === "string" && payment.settlementDispatchRequestedAt.trim() !== "" && payment.settlementDispatchRequestedAt === payment.settlementDispatchRequestedAt.trim() ? Date.parse(payment.settlementDispatchRequestedAt) : NaN
  const paidAt = typeof payment.paidAt === "string" && payment.paidAt.trim() !== "" && payment.paidAt === payment.paidAt.trim() ? Date.parse(payment.paidAt) : NaN
  if (!(Number.isFinite(dispatchAt) && Number.isFinite(paidAt) && dispatchAt === paidAt && dispatchAt <= now)) missing.push("dispatch")
  if (!(typeof payment.amount === "number" && Number.isFinite(payment.amount) && payment.amount > 0 && typeof payment.customerAmount === "number" && Number.isFinite(payment.customerAmount) && payment.customerAmount > 0 && payment.amount === payment.customerAmount)) missing.push("amount")
  if (!(typeof payment.piPaymentId === "string" && payment.piPaymentId.trim() !== "" && payment.piPaymentId === payment.piPaymentId.trim())) missing.push("piId")
  if (!(typeof payment.merchantId === "string" && payment.merchantId.trim() !== "" && payment.merchantId === payment.merchantId.trim())) missing.push("merchantId")
  if (!(typeof payment.merchantUid === "string" && payment.merchantUid.trim() !== "" && payment.merchantUid === payment.merchantUid.trim())) missing.push("merchantUid")
  if (!hasSettlementMerchantProjectionAuthority(payment)) missing.push("merchantAuthority")
  if (!(typeof payment.payerUid === "string" && payment.payerUid.trim() !== "" && payment.payerUid === payment.payerUid.trim())) missing.push("payerUid")
  if (payment.payerUidSource !== "verified_u2a") missing.push("payerSource")
  if (!(typeof payment.payerUidCapturedAt === "string" && payment.payerUidCapturedAt.trim() !== "" && payment.payerUidCapturedAt === payment.payerUidCapturedAt.trim() && Number.isFinite(Date.parse(payment.payerUidCapturedAt)) && Date.parse(payment.payerUidCapturedAt) <= now)) missing.push("payerAt")
  if (!(typeof payment.u2aTxid === "string" && payment.u2aTxid === payment.u2aTxid.trim() && /^[0-9a-f]{64}$/.test(payment.u2aTxid))) missing.push("u2aTxid")
  return missing.length === 0 ? "none" : missing.join(",")
}


const LEGACY_READY_QUARANTINE_LIMIT = 5
const LEGACY_READY_CAPTURE_LAG_MS = 5 * 60_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function hasNoSettlementOrRefundMovementEvidence(payment: Payment): boolean {
  return payment.a2uPaymentId === undefined && payment.a2uTxid === undefined && payment.a2uPreparedEnvelopeXdr === undefined && payment.a2uPreparedTxHash === undefined && payment.a2uPreparedSequence === undefined &&
    payment.horizonSuccessFlag !== true && payment.piCompletionPending !== true && payment.piCompleted !== true && payment.requiresDbReconciliation !== true && payment.dbRecorded !== true &&
    payment.refundPaymentId === undefined && payment.refundTxid === undefined && payment.refundProof === undefined
}

function isLegacyReadyUnrepairedCandidate(payment: Payment, now: number): boolean {
  return payment.status === "paid_to_app" &&
    readyOtherFreshPrerequisiteFingerprint(payment, now) === "dispatch,payerUid,payerSource,payerAt" &&
    payment.settlementFailureState === undefined && payment.refundStatus === undefined &&
    hasNoSettlementOrRefundMovementEvidence(payment)
}

function isLegacyReadyPreviouslyRepairedCandidate(payment: Payment, now: number): boolean {
  const paidAt = typeof payment.paidAt === "string" && payment.paidAt.trim() !== "" && payment.paidAt === payment.paidAt.trim() ? Date.parse(payment.paidAt) : NaN
  const capturedAt = typeof payment.payerUidCapturedAt === "string" && payment.payerUidCapturedAt.trim() !== "" && payment.payerUidCapturedAt === payment.payerUidCapturedAt.trim() ? Date.parse(payment.payerUidCapturedAt) : NaN
  return payment.status === "paid_to_app" &&
    typeof payment.settlementDispatchRequestedAt === "string" && payment.settlementDispatchRequestedAt === payment.paidAt &&
    typeof payment.payerUid === "string" && payment.payerUid.trim() !== "" && payment.payerUid === payment.payerUid.trim() && payment.payerUidSource === "verified_u2a" &&
    Number.isFinite(paidAt) && Number.isFinite(capturedAt) && capturedAt <= now && capturedAt - paidAt >= LEGACY_READY_CAPTURE_LAG_MS &&
    payment.settlementFailureState === undefined && payment.refundStatus === undefined && payment.retryCount === undefined && payment.lastAttemptAt === undefined && payment.nextRetryAt === undefined &&
    hasNoSettlementOrRefundMovementEvidence(payment)
}

async function quarantinePreviouslyRepairedLegacyReadyCandidate(paymentId: string): Promise<boolean> {
  const raw = await redis.get(`payment:${paymentId}`)
  const payment = parsePayment(raw)
  const now = Date.now()
  if (!payment || payment.id !== paymentId || !isLegacyReadyPreviouslyRepairedCandidate(payment, now)) return false
  const result = await redis.eval<[string], number>(`
local latest=redis.call('GET',KEYS[1]); if not latest then return 0 end
local ok,current=pcall(cjson.decode,latest); if not ok or type(current)~='table' then return 0 end
if current.id~=ARGV[1] or current.status~='paid_to_app' then return 0 end
if current.settlementFailureState~=nil or current.refundStatus~=nil or current.retryCount~=nil or current.lastAttemptAt~=nil or current.nextRetryAt~=nil then return 0 end
if current.payerUidSource~='verified_u2a' or current.payerUid==nil or current.payerUidCapturedAt==nil or current.paidAt==nil or current.settlementDispatchRequestedAt~=current.paidAt then return 0 end
if current.a2uPaymentId~=nil or current.a2uTxid~=nil or current.a2uPreparedEnvelopeXdr~=nil or current.a2uPreparedTxHash~=nil or current.a2uPreparedSequence~=nil then return 0 end
if current.horizonSuccessFlag==true or current.piCompletionPending==true or current.piCompleted==true or current.requiresDbReconciliation==true or current.dbRecorded==true then return 0 end
if current.refundPaymentId~=nil or current.refundTxid~=nil or current.refundProof~=nil then return 0 end
local projectionVersion=current.redisProjectionVersion; if projectionVersion==nil then projectionVersion=0 end
if type(projectionVersion)~='number' or projectionVersion<0 or projectionVersion~=math.floor(projectionVersion) then return 0 end
current.settlementDispatchRequestedAt=nil; current.settlementFailureState='held'; current.refundStatus='manual_review_required'; current.a2uErrorCode='legacy_merchant_authority_reverification_required'; current.a2uErrorMessage='Legacy merchant authorization must be reverified before settlement'; current.redisProjectionVersion=projectionVersion+1
redis.call('SET',KEYS[1],cjson.encode(current)); redis.call('SREM',KEYS[2],ARGV[1]); redis.call('ZREM',KEYS[3],ARGV[1]); return 1
`, [`payment:${paymentId}`, "flashpay:recovery:active-payments:v1", "flashpay:settlement:ready:v1"], [paymentId])
  return result === 1
}

async function quarantineLegacyReadyCandidate(paymentId: string): Promise<boolean> {
  const alreadyRepaired = await quarantinePreviouslyRepairedLegacyReadyCandidate(paymentId)
  if (alreadyRepaired) return true
  if (!serverConfig.isPiApiKeyConfigured) return false
  const raw = await redis.get(`payment:${paymentId}`)
  const payment = parsePayment(raw)
  const now = Date.now()
  if (!payment || payment.id !== paymentId || !isLegacyReadyUnrepairedCandidate(payment, now)) return false
  const piPaymentId = payment.piPaymentId
  const u2aTxid = payment.u2aTxid
  const paidAt = payment.paidAt
  if (typeof piPaymentId !== "string" || typeof u2aTxid !== "string" || typeof paidAt !== "string") return false
  let response: Response
  try {
    response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(piPaymentId)}`, {
      method: "GET",
      headers: { Authorization: `Key ${serverConfig.piApiKey}`, "Content-Type": "application/json" },
      cache: "no-store",
    })
  } catch {
    return false
  }
  if (!response.ok) return false
  const dto = asRecord(await response.json().catch(() => null))
  const status = dto ? asRecord(dto.status) : null
  const transaction = dto ? asRecord(dto.transaction) : null
  const metadata = dto ? asRecord(dto.metadata) : null
  const user = dto ? asRecord(dto.user) : null
  const payerUid = typeof dto?.user_uid === "string" ? dto.user_uid : typeof user?.uid === "string" ? user.uid : null
  const authoritative = dto !== null &&
    dto.identifier === piPaymentId && dto.direction === "user_to_app" &&
    typeof dto.amount === "number" && dto.amount === payment.customerAmount && dto.amount === payment.amount &&
    metadata?.paymentId === paymentId && transaction?.txid === u2aTxid &&
    status?.transaction_verified === true && status?.developer_completed === true && status?.cancelled !== true && status?.user_cancelled !== true &&
    typeof payerUid === "string" && payerUid.trim() !== "" && payerUid === payerUid.trim()
  if (!authoritative || payerUid === null) return false
  const capturedAt = new Date().toISOString()
  const result = await redis.eval<[string, string, string, string, string, string], number>(`
local latest=redis.call('GET',KEYS[1]); if not latest then return 0 end
local ok,current=pcall(cjson.decode,latest); if not ok or type(current)~='table' then return 0 end
if current.id~=ARGV[1] or current.status~='paid_to_app' then return 0 end
if current.piPaymentId~=ARGV[2] or current.u2aTxid~=ARGV[3] or current.paidAt~=ARGV[4] then return 0 end
if current.payerUid~=nil or current.payerUidSource~=nil or current.payerUidCapturedAt~=nil or current.settlementDispatchRequestedAt~=nil then return 0 end
if current.settlementFailureState~=nil or current.refundStatus~=nil then return 0 end
if current.a2uPaymentId~=nil or current.a2uTxid~=nil or current.a2uPreparedEnvelopeXdr~=nil or current.a2uPreparedTxHash~=nil or current.a2uPreparedSequence~=nil then return 0 end
if current.horizonSuccessFlag==true or current.piCompletionPending==true or current.piCompleted==true or current.requiresDbReconciliation==true or current.dbRecorded==true then return 0 end
if current.refundPaymentId~=nil or current.refundTxid~=nil or current.refundProof~=nil then return 0 end
local projectionVersion=current.redisProjectionVersion; if projectionVersion==nil then projectionVersion=0 end
if type(projectionVersion)~='number' or projectionVersion<0 or projectionVersion~=math.floor(projectionVersion) then return 0 end
current.payerUid=ARGV[5]; current.payerUidSource='verified_u2a'; current.payerUidCapturedAt=ARGV[6]; current.settlementFailureState='held'; current.refundStatus='manual_review_required'; current.a2uErrorCode='legacy_merchant_authority_reverification_required'; current.a2uErrorMessage='Legacy merchant authorization must be reverified before settlement'; current.redisProjectionVersion=projectionVersion+1
redis.call('SET',KEYS[1],cjson.encode(current)); redis.call('SREM',KEYS[2],ARGV[1]); redis.call('ZREM',KEYS[3],ARGV[1]); return 1
`, [`payment:${paymentId}`, "flashpay:recovery:active-payments:v1", "flashpay:settlement:ready:v1"], [paymentId, piPaymentId, u2aTxid, paidAt, payerUid, capturedAt])
  return result === 1
}

function isPiA2USlotReleasedForDbPending(payment: Payment | null): payment is Payment {
  if (payment === null) return false
  const a2uPaymentIdValid = typeof payment.a2uPaymentId === "string" && payment.a2uPaymentId.trim() !== "" && payment.a2uPaymentId === payment.a2uPaymentId.trim()
  const a2uTxidValid = typeof payment.a2uTxid === "string" && /^[0-9a-f]{64}$/.test(payment.a2uTxid)
  const amountsValid = typeof payment.customerAmount === "number" && Number.isFinite(payment.customerAmount) && payment.customerAmount > 0 && typeof payment.merchantAmount === "number" && Number.isFinite(payment.merchantAmount) && payment.merchantAmount === payment.customerAmount
  const feeValid = typeof payment.horizonFeeCharged === "number" && Number.isFinite(payment.horizonFeeCharged) && payment.horizonFeeCharged >= 0
  const netValid = payment.appCommission === 0 && typeof payment.appNetImpact === "number" && Number.isFinite(payment.appNetImpact) && amountsValid && feeValid && payment.appNetImpact === payment.customerAmount! - payment.merchantAmount! - payment.horizonFeeCharged!
  return payment.status === "settlement_pending" && payment.piCompleted === true && payment.piCompletionPending === false && payment.horizonSuccessFlag === true && payment.requiresDbReconciliation === true && payment.dbRecorded !== true && a2uPaymentIdValid && a2uTxidValid && amountsValid && feeValid && netValid
}

function isFreshSettlementDispatchCandidate(payment: Payment, now: number): boolean {
  if (isLegacyReadyPreviouslyRepairedCandidate(payment, now)) return false
  const dispatchAt = typeof payment.settlementDispatchRequestedAt === "string" && payment.settlementDispatchRequestedAt.trim() !== "" && payment.settlementDispatchRequestedAt === payment.settlementDispatchRequestedAt.trim() ? Date.parse(payment.settlementDispatchRequestedAt) : NaN
  const paidAt = typeof payment.paidAt === "string" && payment.paidAt.trim() !== "" && payment.paidAt === payment.paidAt.trim() ? Date.parse(payment.paidAt) : NaN
  const u2aTxid = payment.u2aTxid
  return (
    payment.status === "paid_to_app" &&
    typeof payment.settlementDispatchRequestedAt === "string" && typeof payment.paidAt === "string" &&
    Number.isFinite(dispatchAt) && Number.isFinite(paidAt) && dispatchAt === paidAt && dispatchAt <= now &&
    typeof payment.amount === "number" && Number.isFinite(payment.amount) && payment.amount > 0 &&
    typeof payment.customerAmount === "number" && Number.isFinite(payment.customerAmount) && payment.customerAmount > 0 && payment.amount === payment.customerAmount &&
    typeof payment.piPaymentId === "string" && payment.piPaymentId.trim() !== "" && payment.piPaymentId === payment.piPaymentId.trim() &&
    typeof payment.merchantId === "string" && payment.merchantId.trim() !== "" && payment.merchantId === payment.merchantId.trim() &&
    typeof payment.merchantUid === "string" && payment.merchantUid.trim() !== "" && payment.merchantUid === payment.merchantUid.trim() &&
    hasSettlementMerchantProjectionAuthority(payment) &&
    typeof payment.payerUid === "string" && payment.payerUid.trim() !== "" && payment.payerUid === payment.payerUid.trim() &&
    payment.payerUidSource === "verified_u2a" &&
    typeof payment.payerUidCapturedAt === "string" && payment.payerUidCapturedAt.trim() !== "" && payment.payerUidCapturedAt === payment.payerUidCapturedAt.trim() && Number.isFinite(Date.parse(payment.payerUidCapturedAt)) && Date.parse(payment.payerUidCapturedAt) <= now &&
    typeof u2aTxid === "string" && u2aTxid === u2aTxid.trim() && /^[0-9a-f]{64}$/.test(u2aTxid) &&
    payment.a2uTxid === undefined &&
    payment.settlementFailureState === undefined && payment.retryCount === undefined && payment.lastAttemptAt === undefined && payment.nextRetryAt === undefined &&
    payment.a2uPaymentId === undefined && payment.a2uPreparedEnvelopeXdr === undefined && payment.a2uPreparedTxHash === undefined && payment.a2uPreparedSequence === undefined && payment.a2uFromAddress === undefined && payment.a2uToAddress === undefined &&
    payment.merchantAmount === undefined && payment.horizonFeeCharged === undefined && payment.appCommission === undefined && payment.appNetImpact === undefined && payment.a2uErrorCode === undefined && payment.a2uErrorMessage === undefined && payment.a2uErrorBody === undefined && payment.horizonSuccessAt === undefined && payment.settledAt === undefined &&
    payment.refundPaymentId === undefined && payment.refundTxid === undefined && payment.refundStatus === undefined && payment.refundFailureCode === undefined && payment.refundProof === undefined && payment.payerRefundEligible !== true &&
    payment.horizonSuccessFlag !== true && payment.piCompletionPending !== true && payment.piCompleted !== true && payment.requiresDbReconciliation !== true && payment.dbRecorded !== true &&
    !hasExcludedState(payment)
  )
}

function isStaleFreshReconcilingCandidate(payment: Payment, now: number): boolean {
  const lastAttemptAt = typeof payment.lastAttemptAt === "string" && payment.lastAttemptAt.trim() !== "" && payment.lastAttemptAt === payment.lastAttemptAt.trim() ? Date.parse(payment.lastAttemptAt) : NaN
  const dispatchAt = typeof payment.settlementDispatchRequestedAt === "string" && payment.settlementDispatchRequestedAt.trim() !== "" && payment.settlementDispatchRequestedAt === payment.settlementDispatchRequestedAt.trim() ? Date.parse(payment.settlementDispatchRequestedAt) : NaN
  const paidAt = typeof payment.paidAt === "string" && payment.paidAt.trim() !== "" && payment.paidAt === payment.paidAt.trim() ? Date.parse(payment.paidAt) : NaN
  const u2aTxid = payment.u2aTxid
  return (
    payment.status === "paid_to_app" &&
    typeof payment.settlementDispatchRequestedAt === "string" && typeof payment.paidAt === "string" &&
    Number.isFinite(dispatchAt) && Number.isFinite(paidAt) && dispatchAt === paidAt && dispatchAt <= now &&
    typeof payment.amount === "number" && Number.isFinite(payment.amount) && payment.amount > 0 &&
    typeof payment.customerAmount === "number" && Number.isFinite(payment.customerAmount) && payment.customerAmount > 0 && payment.amount === payment.customerAmount &&
    typeof payment.piPaymentId === "string" && payment.piPaymentId.trim() !== "" && payment.piPaymentId === payment.piPaymentId.trim() &&
    typeof payment.merchantId === "string" && payment.merchantId.trim() !== "" && payment.merchantId === payment.merchantId.trim() &&
    typeof payment.merchantUid === "string" && payment.merchantUid.trim() !== "" && payment.merchantUid === payment.merchantUid.trim() &&
    hasSettlementMerchantProjectionAuthority(payment) &&
    typeof payment.payerUid === "string" && payment.payerUid.trim() !== "" && payment.payerUid === payment.payerUid.trim() &&
    payment.payerUidSource === "verified_u2a" &&
    typeof payment.payerUidCapturedAt === "string" && payment.payerUidCapturedAt.trim() !== "" && payment.payerUidCapturedAt === payment.payerUidCapturedAt.trim() && Number.isFinite(Date.parse(payment.payerUidCapturedAt)) && Date.parse(payment.payerUidCapturedAt) <= now &&
    typeof u2aTxid === "string" && u2aTxid === u2aTxid.trim() && /^[0-9a-f]{64}$/.test(u2aTxid) &&
    payment.a2uTxid === undefined &&
    payment.settlementFailureState === "reconciling" && payment.retryCount === 1 && payment.nextRetryAt === undefined &&
    Number.isFinite(lastAttemptAt) && lastAttemptAt <= now - 660000 &&
    payment.a2uPaymentId === undefined && payment.a2uPreparedEnvelopeXdr === undefined && payment.a2uPreparedTxHash === undefined && payment.a2uPreparedSequence === undefined && payment.a2uFromAddress === undefined && payment.a2uToAddress === undefined &&
    payment.merchantAmount === undefined && payment.horizonFeeCharged === undefined && payment.appCommission === undefined && payment.appNetImpact === undefined && payment.a2uErrorCode === undefined && payment.a2uErrorMessage === undefined && payment.a2uErrorBody === undefined && payment.horizonSuccessAt === undefined && payment.settledAt === undefined &&
    payment.refundPaymentId === undefined && payment.refundTxid === undefined && payment.refundStatus === undefined && payment.refundFailureCode === undefined && payment.refundProof === undefined && payment.payerRefundEligible !== true &&
    payment.horizonSuccessFlag !== true && payment.piCompletionPending !== true && payment.piCompleted !== true && payment.requiresDbReconciliation !== true && payment.dbRecorded !== true &&
    !hasExcludedState(payment)
  )
}

function isStaleRetryReconcilingCandidate(payment: Payment, now: number): boolean {
  const lastAttemptAt = typeof payment.lastAttemptAt === "string" && payment.lastAttemptAt.trim() !== "" && payment.lastAttemptAt === payment.lastAttemptAt.trim() ? Date.parse(payment.lastAttemptAt) : NaN
  const nextRetryAt = typeof payment.nextRetryAt === "string" && payment.nextRetryAt.trim() !== "" && payment.nextRetryAt === payment.nextRetryAt.trim() ? Date.parse(payment.nextRetryAt) : NaN
  const dispatchAt = typeof payment.settlementDispatchRequestedAt === "string" && payment.settlementDispatchRequestedAt.trim() !== "" && payment.settlementDispatchRequestedAt === payment.settlementDispatchRequestedAt.trim() ? Date.parse(payment.settlementDispatchRequestedAt) : NaN
  const paidAt = typeof payment.paidAt === "string" && payment.paidAt.trim() !== "" && payment.paidAt === payment.paidAt.trim() ? Date.parse(payment.paidAt) : NaN
  const u2aTxid = payment.u2aTxid
  return (
    payment.status === "paid_to_app" &&
    typeof payment.settlementDispatchRequestedAt === "string" && typeof payment.paidAt === "string" &&
    Number.isFinite(dispatchAt) && Number.isFinite(paidAt) && dispatchAt === paidAt && dispatchAt <= now &&
    typeof payment.amount === "number" && Number.isFinite(payment.amount) && payment.amount > 0 &&
    typeof payment.customerAmount === "number" && Number.isFinite(payment.customerAmount) && payment.customerAmount > 0 && payment.amount === payment.customerAmount &&
    typeof payment.piPaymentId === "string" && payment.piPaymentId.trim() !== "" && payment.piPaymentId === payment.piPaymentId.trim() &&
    typeof payment.merchantId === "string" && payment.merchantId.trim() !== "" && payment.merchantId === payment.merchantId.trim() &&
    typeof payment.merchantUid === "string" && payment.merchantUid.trim() !== "" && payment.merchantUid === payment.merchantUid.trim() &&
    hasSettlementMerchantProjectionAuthority(payment) &&
    typeof payment.payerUid === "string" && payment.payerUid.trim() !== "" && payment.payerUid === payment.payerUid.trim() &&
    payment.payerUidSource === "verified_u2a" &&
    typeof payment.payerUidCapturedAt === "string" && payment.payerUidCapturedAt.trim() !== "" && payment.payerUidCapturedAt === payment.payerUidCapturedAt.trim() && Number.isFinite(Date.parse(payment.payerUidCapturedAt)) && Date.parse(payment.payerUidCapturedAt) <= now &&
    typeof u2aTxid === "string" && u2aTxid === u2aTxid.trim() && /^[0-9a-f]{64}$/.test(u2aTxid) &&
    payment.a2uTxid === undefined &&
    payment.settlementFailureState === "reconciling" && typeof payment.retryCount === "number" && Number.isInteger(payment.retryCount) && payment.retryCount >= 2 &&
    Number.isFinite(lastAttemptAt) && lastAttemptAt <= now - 660000 && Number.isFinite(nextRetryAt) && nextRetryAt <= lastAttemptAt &&
    payment.a2uPaymentId === undefined && payment.a2uPreparedEnvelopeXdr === undefined && payment.a2uPreparedTxHash === undefined && payment.a2uPreparedSequence === undefined && payment.a2uFromAddress === undefined && payment.a2uToAddress === undefined &&
    payment.merchantAmount === undefined && payment.horizonFeeCharged === undefined && payment.appCommission === undefined && payment.appNetImpact === undefined && (payment.a2uErrorCode === undefined || typeof payment.a2uErrorCode === "string" && payment.a2uErrorCode.trim() !== "") && (payment.a2uErrorMessage === undefined || typeof payment.a2uErrorMessage === "string" && payment.a2uErrorMessage.trim() !== "") && (payment.a2uErrorBody === undefined || typeof payment.a2uErrorBody === "string" && payment.a2uErrorBody.trim() !== "") && payment.horizonSuccessAt === undefined && payment.settledAt === undefined &&
    payment.refundPaymentId === undefined && payment.refundTxid === undefined && (payment.refundStatus === undefined || payment.refundStatus === "not_started") && payment.refundFailureCode === undefined && payment.refundProof === undefined && payment.payerRefundEligible !== true &&
    payment.horizonSuccessFlag !== true && payment.piCompletionPending !== true && payment.piCompleted !== true && payment.requiresDbReconciliation !== true && payment.dbRecorded !== true &&
    !hasExcludedState(payment)
  )
}

function isPreparedSubmitEligible(payment: Payment): boolean {
  return (
    payment.status === "settlement_pending" &&
    typeof payment.a2uPaymentId === "string" && payment.a2uPaymentId.trim() !== "" && payment.a2uPaymentId === payment.a2uPaymentId.trim() &&
    typeof payment.a2uPreparedEnvelopeXdr === "string" && payment.a2uPreparedEnvelopeXdr.trim() !== "" && payment.a2uPreparedEnvelopeXdr === payment.a2uPreparedEnvelopeXdr.trim() &&
    typeof payment.a2uFromAddress === "string" && payment.a2uFromAddress.trim() !== "" && payment.a2uFromAddress === payment.a2uFromAddress.trim() &&
    typeof payment.a2uToAddress === "string" && payment.a2uToAddress.trim() !== "" && payment.a2uToAddress === payment.a2uToAddress.trim() &&
    typeof payment.a2uPreparedTxHash === "string" && /^[0-9a-f]{64}$/.test(payment.a2uPreparedTxHash) && payment.a2uPreparedTxHash === payment.a2uPreparedTxHash.trim() &&
    typeof payment.a2uPreparedSequence === "string" && /^[1-9][0-9]*$/.test(payment.a2uPreparedSequence) &&
    typeof payment.customerAmount === "number" && Number.isFinite(payment.customerAmount) && payment.customerAmount > 0 &&
    typeof payment.merchantAmount === "number" && Number.isFinite(payment.merchantAmount) && payment.merchantAmount > 0 &&
    payment.a2uTxid === undefined &&
    payment.horizonSuccessFlag !== true &&
    payment.piCompletionPending !== true &&
    payment.piCompleted !== true &&
    payment.requiresDbReconciliation !== true &&
    payment.dbRecorded !== true &&
    payment.refundPaymentId === undefined &&
    payment.refundTxid === undefined &&
    (payment.refundStatus === undefined || payment.refundStatus === "not_started") &&
    !hasExcludedState(payment)
  )
}

function isEligible(payment: Payment, now: number): boolean {
  const nextRetryAt = payment.nextRetryAt ? Date.parse(payment.nextRetryAt) : NaN

  return (
    payment.status === "paid_to_app" &&
    payment.settlementFailureState === "retryable" &&
    typeof payment.retryCount === "number" &&
    Number.isFinite(payment.retryCount) &&
    payment.retryCount > 0 &&
    Number.isFinite(nextRetryAt) &&
    nextRetryAt <= now &&
    !payment.a2uTxid &&
    payment.horizonSuccessFlag !== true &&
    !hasExcludedState(payment)
  )
}

function isPostHorizonEligible(payment: Payment, now: number): boolean {
  const nextRetryAt = payment.nextRetryAt === undefined ? now : typeof payment.nextRetryAt === "string" && payment.nextRetryAt !== "" && payment.nextRetryAt === payment.nextRetryAt.trim() && Number.isFinite(Date.parse(payment.nextRetryAt)) ? Date.parse(payment.nextRetryAt) : NaN

  return (
    payment.status === "settlement_pending" &&
    Boolean(payment.a2uPaymentId) &&
    Boolean(payment.a2uTxid) &&
    payment.horizonSuccessFlag === true &&
    !hasExcludedState(payment) &&
    Number.isFinite(nextRetryAt) &&
    nextRetryAt <= now &&
    ((payment.piCompletionPending === true && payment.piCompleted !== true) ||
      (payment.piCompleted === true && payment.dbRecorded !== true))
  )
}

export async function POST(request: NextRequest) {
  if (!hasValidSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  if (!isRedisConfigured) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 })
  }

  // F1D2 temporary certification hook: after this already-secret-authenticated wake,
  // run the SELECT-only balance-integrity proof once and emit aggregate evidence to Vercel logs.
  // It never writes PostgreSQL accounting state and never changes recovery decisions.
  try {
    after(async () => {
      let claimed = false
      try {
        const claim = await redis.set(F1_BALANCE_DIAGNOSTIC_ONCE_KEY, "running", { nx: true, ex: 10 * 60 })
        claimed = claim === "OK"
        if (!claimed) return
        const [mismatches, duplicatePayments, duplicateReceipts, constraints, totals] = await Promise.all([
          query(`WITH canonical AS (SELECT merchant_id, COALESCE(SUM(merchant_amount),0) canonical_settled FROM receipts WHERE settlement_status='settled_to_merchant' GROUP BY merchant_id), all_merchants AS (SELECT merchant_id FROM merchant_balances UNION SELECT merchant_id FROM canonical) SELECT m.merchant_id, COALESCE(b.settled,0) stored_settled, COALESCE(c.canonical_settled,0) canonical_settled, COALESCE(b.settled,0)-COALESCE(c.canonical_settled,0) settled_delta, COALESCE(b.unsettled,0) stored_unsettled FROM all_merchants m LEFT JOIN merchant_balances b ON b.merchant_id=m.merchant_id LEFT JOIN canonical c ON c.merchant_id=m.merchant_id WHERE COALESCE(b.settled,0)<>COALESCE(c.canonical_settled,0) OR COALESCE(b.unsettled,0)<>0 ORDER BY m.merchant_id`),
          query(`SELECT payment_id, COUNT(*) duplicate_count FROM transactions GROUP BY payment_id HAVING COUNT(*)>1 ORDER BY payment_id`),
          query(`SELECT transaction_id, COUNT(*) duplicate_count FROM receipts GROUP BY transaction_id HAVING COUNT(*)>1 ORDER BY transaction_id`),
          query(`SELECT conrelid::regclass::text table_name, conname, contype, pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid IN ('transactions'::regclass,'receipts'::regclass,'merchant_balances'::regclass) ORDER BY conrelid::regclass::text, conname`),
          query(`SELECT (SELECT COUNT(*) FROM merchant_balances) merchant_balance_rows, (SELECT COUNT(*) FROM transactions) transaction_rows, (SELECT COUNT(*) FROM receipts) receipt_rows, (SELECT COUNT(*) FROM receipts WHERE settlement_status='settled_to_merchant') settled_receipt_rows`)
        ])
        if (![mismatches, duplicatePayments, duplicateReceipts, constraints, totals].every(Array.isArray)) throw new Error("F1D2 diagnostic indeterminate")
        console.log("[F1D2 BALANCE INTEGRITY PROOF]", {
          readOnly: true,
          mismatchCount: mismatches!.length,
          duplicatePaymentIdCount: duplicatePayments!.length,
          duplicateReceiptTransactionIdCount: duplicateReceipts!.length,
          totals: totals![0] ?? null,
          mismatches,
          constraints,
        })
        await redis.set(F1_BALANCE_DIAGNOSTIC_ONCE_KEY, "done", { ex: 7 * 24 * 60 * 60 })
      } catch (error) {
        if (claimed) { try { await redis.del(F1_BALANCE_DIAGNOSTIC_ONCE_KEY) } catch {} }
        console.error("[F1D2 BALANCE INTEGRITY PROOF] failed", error instanceof Error ? error.message : String(error))
      }
    })
  } catch {}

  // F1E temporary forensic certification hook: one PostgreSQL SELECT statement = one statement snapshot.
  // It attributes the proven materialized-balance drift without mutating PostgreSQL or recovery state.
  try {
    after(async () => {
      let claimed = false
      try {
        const claim = await redis.set(F1_FORENSIC_ATTRIBUTION_ONCE_KEY, "running", { nx: true, ex: 10 * 60 })
        claimed = claim === "OK"
        if (!claimed) return
        const rows = await query(`
          WITH canonical AS (
            SELECT merchant_id,
                   COALESCE(SUM(merchant_amount) FILTER (WHERE settlement_status = 'settled_to_merchant'), 0) AS canonical_settled,
                   COUNT(*) FILTER (WHERE settlement_status = 'settled_to_merchant') AS settled_receipts,
                   COUNT(*) FILTER (WHERE settlement_status <> 'settled_to_merchant' OR settlement_status IS NULL) AS nonsettled_receipts
            FROM receipts
            GROUP BY merchant_id
          ),
          drift_merchants AS (
            SELECT m.merchant_id,
                   COALESCE(b.settled, 0) AS stored_settled,
                   COALESCE(c.canonical_settled, 0) AS canonical_settled,
                   COALESCE(b.settled, 0) - COALESCE(c.canonical_settled, 0) AS settled_delta,
                   COALESCE(b.unsettled, 0) AS stored_unsettled,
                   COALESCE(c.settled_receipts, 0) AS settled_receipts,
                   COALESCE(c.nonsettled_receipts, 0) AS nonsettled_receipts
            FROM (SELECT merchant_id FROM merchant_balances UNION SELECT merchant_id FROM canonical) m
            LEFT JOIN merchant_balances b ON b.merchant_id = m.merchant_id
            LEFT JOIN canonical c ON c.merchant_id = m.merchant_id
            WHERE COALESCE(b.settled, 0) <> COALESCE(c.canonical_settled, 0)
               OR COALESCE(b.unsettled, 0) <> 0
          ),
          affected_ledger AS (
            SELECT t.merchant_id, t.payment_id, t.amount AS transaction_amount, t.status AS transaction_status,
                   t.created_at AS transaction_created_at, t.completed_at,
                   r.id AS receipt_id, r.merchant_amount, r.customer_amount, r.amount AS receipt_amount,
                   r.settlement_status, r.u2a_identifier, r.u2a_txid, r.a2u_identifier, r.a2u_txid, r.created_at AS receipt_created_at
            FROM transactions t
            LEFT JOIN receipts r ON r.transaction_id = t.id
            WHERE t.merchant_id IN (SELECT merchant_id FROM drift_merchants)
          ),
          orphan_transactions AS (
            SELECT t.id, t.payment_id, t.merchant_id, t.amount, t.status, t.created_at, t.completed_at
            FROM transactions t LEFT JOIN receipts r ON r.transaction_id = t.id
            WHERE r.id IS NULL
          ),
          refund_overlap AS (
            SELECT ra.payment_id, ra.refund_id, ra.amount AS refund_amount, t.merchant_id,
                   r.settlement_status, r.merchant_amount, r.a2u_txid AS settlement_txid, ra.refund_txid
            FROM refund_accounting_records ra
            JOIN transactions t ON t.payment_id = ra.payment_id
            JOIN receipts r ON r.transaction_id = t.id
            WHERE r.settlement_status = 'settled_to_merchant'
          ),
          receipt_statuses AS (
            SELECT COALESCE(settlement_status, '<NULL>') AS status, COUNT(*) AS count,
                   COALESCE(SUM(merchant_amount), 0) AS merchant_amount_sum
            FROM receipts GROUP BY settlement_status
          ),
          constraints AS (
            SELECT conrelid::regclass::text AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
            WHERE conrelid IN ('transactions'::regclass,'receipts'::regclass,'merchant_balances'::regclass)
            ORDER BY conrelid::regclass::text, conname
          )
          SELECT jsonb_build_object(
            'driftMerchantCount', (SELECT COUNT(*) FROM drift_merchants),
            'settledDriftMerchantCount', (SELECT COUNT(*) FROM drift_merchants WHERE settled_delta <> 0),
            'unsettledNonzeroMerchantCount', (SELECT COUNT(*) FROM drift_merchants WHERE stored_unsettled <> 0),
            'totalSettledDelta', (SELECT COALESCE(SUM(settled_delta),0) FROM drift_merchants),
            'totalStoredUnsettled', (SELECT COALESCE(SUM(stored_unsettled),0) FROM drift_merchants),
            'orphanTransactionCount', (SELECT COUNT(*) FROM orphan_transactions),
            'refundSettledOverlapCount', (SELECT COUNT(*) FROM refund_overlap),
            'settledReceiptNullMerchantAmountCount', (SELECT COUNT(*) FROM receipts WHERE settlement_status='settled_to_merchant' AND merchant_amount IS NULL),
            'settledReceiptAmountMismatchCount', (SELECT COUNT(*) FROM receipts WHERE settlement_status='settled_to_merchant' AND merchant_amount IS NOT NULL AND amount <> merchant_amount),
            'transactionReceiptMerchantMismatchCount', (SELECT COUNT(*) FROM transactions t JOIN receipts r ON r.transaction_id=t.id WHERE t.merchant_id <> r.merchant_id),
            'driftMerchants', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY abs(d.settled_delta) DESC, d.merchant_id) FROM drift_merchants d), '[]'::jsonb),
            'affectedLedger', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.merchant_id, a.transaction_created_at, a.payment_id) FROM affected_ledger a), '[]'::jsonb),
            'orphanTransactions', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.created_at, o.payment_id) FROM orphan_transactions o), '[]'::jsonb),
            'refundSettledOverlaps', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.payment_id) FROM refund_overlap x), '[]'::jsonb),
            'receiptStatuses', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.status) FROM receipt_statuses s), '[]'::jsonb),
            'constraints', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM constraints c), '[]'::jsonb)
          ) AS proof
        `)
        if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object" || !("proof" in rows[0])) throw new Error("F1E forensic attribution indeterminate")
        const proof = (rows[0] as Record<string, unknown>).proof
        if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Error("F1E forensic proof shape invalid")
        const p = proof as Record<string, unknown>
        const driftMerchants = Array.isArray(p.driftMerchants) ? p.driftMerchants : null
        const affectedLedger = Array.isArray(p.affectedLedger) ? p.affectedLedger : null
        const orphanTransactions = Array.isArray(p.orphanTransactions) ? p.orphanTransactions : null
        const refundSettledOverlaps = Array.isArray(p.refundSettledOverlaps) ? p.refundSettledOverlaps : null
        const receiptStatuses = Array.isArray(p.receiptStatuses) ? p.receiptStatuses : null
        const constraints = Array.isArray(p.constraints) ? p.constraints : null
        if (!driftMerchants || !affectedLedger || !orphanTransactions || !refundSettledOverlaps || !receiptStatuses || !constraints) throw new Error("F1E forensic proof arrays invalid")
        console.log("[F1E FORENSIC SUMMARY]", {
          driftMerchantCount: p.driftMerchantCount,
          settledDriftMerchantCount: p.settledDriftMerchantCount,
          unsettledNonzeroMerchantCount: p.unsettledNonzeroMerchantCount,
          totalSettledDelta: p.totalSettledDelta,
          totalStoredUnsettled: p.totalStoredUnsettled,
          orphanTransactionCount: p.orphanTransactionCount,
          refundSettledOverlapCount: p.refundSettledOverlapCount,
          settledReceiptNullMerchantAmountCount: p.settledReceiptNullMerchantAmountCount,
          settledReceiptAmountMismatchCount: p.settledReceiptAmountMismatchCount,
          transactionReceiptMerchantMismatchCount: p.transactionReceiptMerchantMismatchCount,
        })
        for (const row of driftMerchants) console.log("[F1E DRIFT MERCHANT]", row)
        for (const row of affectedLedger) console.log("[F1E AFFECTED LEDGER]", row)
        for (const row of orphanTransactions) console.log("[F1E ORPHAN TRANSACTION]", row)
        for (const row of refundSettledOverlaps) console.log("[F1E REFUND-SETTLED OVERLAP]", row)
        for (const row of receiptStatuses) console.log("[F1E RECEIPT STATUS]", row)
        for (const row of constraints) console.log("[F1E CONSTRAINT]", row)
        console.log("[F1E FORENSIC ATTRIBUTION PROOF] complete", { readOnly: true })
        await redis.set(F1_FORENSIC_ATTRIBUTION_ONCE_KEY, "done", { ex: 7 * 24 * 60 * 60 })
      } catch (error) {
        if (claimed) { try { await redis.del(F1_FORENSIC_ATTRIBUTION_ONCE_KEY) } catch {} }
        console.error("[F1E FORENSIC ATTRIBUTION PROOF] failed", error instanceof Error ? error.message : String(error))
      }
    })
  } catch {}

  // F1F temporary root-cause certification hook: SELECT-only and one PostgreSQL statement snapshot.
  // It proves the exact relationship between legacy unsettled state, canonical settled receipts,
  // the single orphan transaction, and the one proven settled drift before any repair is allowed.
  try {
    after(async () => {
      let claimed = false
      try {
        const claim = await redis.set(F1_ROOT_CAUSE_CERT_ONCE_KEY, "running", { nx: true, ex: 10 * 60 })
        claimed = claim === "OK"
        if (!claimed) return
        const rows = await query(`
          WITH receipt_rollup AS (
            SELECT r.merchant_id,
                   COALESCE(SUM(r.merchant_amount) FILTER (WHERE r.settlement_status='settled_to_merchant'),0) canonical_settled,
                   COALESCE(SUM(r.amount) FILTER (WHERE r.settlement_status IS DISTINCT FROM 'settled_to_merchant'),0) nonsettled_receipt_amount,
                   COALESCE(SUM(r.amount) FILTER (WHERE r.settlement_status IS DISTINCT FROM 'settled_to_merchant' AND r.merchant_amount IS NULL),0) legacy_nonsettled_receipt_amount,
                   COUNT(*) FILTER (WHERE r.settlement_status IS DISTINCT FROM 'settled_to_merchant') nonsettled_receipt_count,
                   COUNT(*) FILTER (WHERE r.settlement_status IS DISTINCT FROM 'settled_to_merchant' AND r.merchant_amount IS NULL) legacy_nonsettled_receipt_count
            FROM receipts r GROUP BY r.merchant_id
          ),
          balance_reconciliation AS (
            SELECT b.merchant_id, b.settled stored_settled, b.unsettled stored_unsettled, b.last_updated,
                   COALESCE(rr.canonical_settled,0) canonical_settled,
                   b.settled-COALESCE(rr.canonical_settled,0) settled_delta,
                   COALESCE(rr.nonsettled_receipt_amount,0) nonsettled_receipt_amount,
                   COALESCE(rr.legacy_nonsettled_receipt_amount,0) legacy_nonsettled_receipt_amount,
                   b.unsettled-COALESCE(rr.nonsettled_receipt_amount,0) unsettled_vs_all_nonsettled_delta,
                   b.unsettled-COALESCE(rr.legacy_nonsettled_receipt_amount,0) unsettled_vs_legacy_nonsettled_delta,
                   COALESCE(rr.nonsettled_receipt_count,0) nonsettled_receipt_count,
                   COALESCE(rr.legacy_nonsettled_receipt_count,0) legacy_nonsettled_receipt_count
            FROM merchant_balances b LEFT JOIN receipt_rollup rr ON rr.merchant_id=b.merchant_id
          ),
          orphan_transactions AS (
            SELECT t.id,t.payment_id,t.merchant_id,t.merchant_uid,t.amount,t.status,t.reference,t.created_at,t.completed_at
            FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id WHERE r.id IS NULL
          ),
          hazem_receipts AS (
            SELECT t.payment_id,t.amount transaction_amount,t.status transaction_status,t.created_at transaction_created_at,t.completed_at,
                   r.id receipt_id,r.amount receipt_amount,r.customer_amount,r.merchant_amount,r.horizon_fee_charged,r.app_commission,r.app_net_impact,
                   r.settlement_status,r.u2a_identifier,r.u2a_txid,r.a2u_identifier,r.a2u_txid,r.created_at receipt_created_at,
                   CASE WHEN r.merchant_amount IS NOT NULL AND r.customer_amount IS NOT NULL AND r.u2a_identifier IS NOT NULL AND r.u2a_txid IS NOT NULL AND r.a2u_identifier IS NOT NULL AND r.a2u_txid IS NOT NULL THEN 'canonical-shape' ELSE 'legacy-shape' END record_shape
            FROM transactions t JOIN receipts r ON r.transaction_id=t.id WHERE t.merchant_id='hazemaboria'
          ),
          hazem_settled AS (
            SELECT * FROM hazem_receipts WHERE settlement_status='settled_to_merchant'
          ),
          hazem_nonsettled AS (
            SELECT * FROM hazem_receipts WHERE settlement_status IS DISTINCT FROM 'settled_to_merchant'
          ),
          hazem_shape_status AS (
            SELECT record_shape,COALESCE(settlement_status,'<NULL>') settlement_status,COUNT(*) row_count,
                   COALESCE(SUM(receipt_amount),0) receipt_amount_sum,COALESCE(SUM(merchant_amount),0) merchant_amount_sum,
                   MIN(receipt_created_at) first_receipt_at,MAX(receipt_created_at) last_receipt_at
            FROM hazem_receipts GROUP BY record_shape,settlement_status
          ),
          hazem_settled_by_day AS (
            SELECT receipt_created_at::date AS settled_date,COUNT(*) row_count,COALESCE(SUM(merchant_amount),0) merchant_amount_sum,
                   MIN(receipt_created_at) first_receipt_at,MAX(receipt_created_at) last_receipt_at
            FROM hazem_settled GROUP BY receipt_created_at::date
          ),
          exact_delta_candidates AS (
            SELECT payment_id,merchant_amount,receipt_created_at,a2u_identifier,a2u_txid
            FROM hazem_settled
            WHERE merchant_amount = (SELECT settled_delta FROM balance_reconciliation WHERE merchant_id='hazemaboria')
          ),
          duplicate_a2u AS (
            SELECT a2u_identifier,COUNT(*) row_count,COALESCE(SUM(merchant_amount),0) merchant_amount_sum
            FROM receipts WHERE a2u_identifier IS NOT NULL GROUP BY a2u_identifier HAVING COUNT(*)>1
          ),
          duplicate_a2u_txid AS (
            SELECT a2u_txid,COUNT(*) row_count,COALESCE(SUM(merchant_amount),0) merchant_amount_sum
            FROM receipts WHERE a2u_txid IS NOT NULL GROUP BY a2u_txid HAVING COUNT(*)>1
          ),
          constraints AS (
            SELECT conrelid::regclass::text table_name,conname,contype,pg_get_constraintdef(oid) definition
            FROM pg_constraint WHERE conrelid IN ('transactions'::regclass,'receipts'::regclass,'merchant_balances'::regclass)
            ORDER BY conrelid::regclass::text,conname
          )
          SELECT jsonb_build_object(
            'balanceReconciliation',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY abs(x.settled_delta) DESC,x.merchant_id) FROM balance_reconciliation x WHERE x.settled_delta<>0 OR x.stored_unsettled<>0),'[]'::jsonb),
            'orphanTransactions',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at) FROM orphan_transactions x),'[]'::jsonb),
            'hazemShapeStatus',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.first_receipt_at) FROM hazem_shape_status x),'[]'::jsonb),
            'hazemSettledByDay',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.settled_date) FROM hazem_settled_by_day x),'[]'::jsonb),
            'hazemSettledLedger',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.receipt_created_at,x.payment_id) FROM hazem_settled x),'[]'::jsonb),
            'hazemNonsettledLedger',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.receipt_created_at,x.payment_id) FROM hazem_nonsettled x),'[]'::jsonb),
            'exactDeltaCandidates',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.receipt_created_at) FROM exact_delta_candidates x),'[]'::jsonb),
            'duplicateA2uIdentifiers',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.a2u_identifier) FROM duplicate_a2u x),'[]'::jsonb),
            'duplicateA2uTxids',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.a2u_txid) FROM duplicate_a2u_txid x),'[]'::jsonb),
            'constraints',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM constraints x),'[]'::jsonb)
          ) proof
        `)
        if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object" || !("proof" in rows[0])) throw new Error("F1F root-cause proof indeterminate")
        const proof = (rows[0] as Record<string, unknown>).proof
        if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Error("F1F root-cause proof shape invalid")
        const p = proof as Record<string, unknown>
        const required = ["balanceReconciliation","orphanTransactions","hazemShapeStatus","hazemSettledByDay","hazemSettledLedger","hazemNonsettledLedger","exactDeltaCandidates","duplicateA2uIdentifiers","duplicateA2uTxids","constraints"] as const
        for (const key of required) if (!Array.isArray(p[key])) throw new Error(`F1F ${key} invalid`)
        console.log("[F1F ROOT CAUSE SUMMARY]", {
          balanceReconciliationCount: (p.balanceReconciliation as unknown[]).length,
          orphanTransactionCount: (p.orphanTransactions as unknown[]).length,
          exactDeltaCandidateCount: (p.exactDeltaCandidates as unknown[]).length,
          duplicateA2uIdentifierCount: (p.duplicateA2uIdentifiers as unknown[]).length,
          duplicateA2uTxidCount: (p.duplicateA2uTxids as unknown[]).length,
          readOnly: true,
        })
        for (const row of p.balanceReconciliation as unknown[]) console.log("[F1F BALANCE RECONCILIATION]", row)
        for (const row of p.orphanTransactions as unknown[]) console.log("[F1F ORPHAN]", row)
        for (const row of p.hazemShapeStatus as unknown[]) console.log("[F1F HAZEM SHAPE STATUS]", row)
        for (const row of p.hazemSettledByDay as unknown[]) console.log("[F1F HAZEM SETTLED DAY]", row)
        for (const row of p.hazemSettledLedger as unknown[]) console.log("[F1F HAZEM SETTLED LEDGER]", row)
        for (const row of p.hazemNonsettledLedger as unknown[]) console.log("[F1F HAZEM NONSETTLED LEDGER]", row)
        for (const row of p.exactDeltaCandidates as unknown[]) console.log("[F1F EXACT DELTA CANDIDATE]", row)
        for (const row of p.duplicateA2uIdentifiers as unknown[]) console.log("[F1F DUPLICATE A2U IDENTIFIER]", row)
        for (const row of p.duplicateA2uTxids as unknown[]) console.log("[F1F DUPLICATE A2U TXID]", row)
        for (const row of p.constraints as unknown[]) console.log("[F1F CONSTRAINT]", row)
        console.log("[F1F ROOT CAUSE CERTIFICATION] complete", { readOnly: true })
        await redis.set(F1_ROOT_CAUSE_CERT_ONCE_KEY, "done", { ex: 7 * 24 * 60 * 60 })
      } catch (error) {
        if (claimed) { try { await redis.del(F1_ROOT_CAUSE_CERT_ONCE_KEY) } catch {} }
        console.error("[F1F ROOT CAUSE CERTIFICATION] failed", error instanceof Error ? error.message : String(error))
      }
    })
  } catch {}

  // F1G guarded historical repair: external movement proof first, then one atomic DB classification repair.
  // It never creates/submits/completes A2U, never changes merchant_balances, and never touches legacy unsettled.
  try {
    after(async () => {
      let claimed = false
      try {
        const claim = await redis.set(F1_GUARDED_REPAIR_ONCE_KEY, "running", { nx: true, ex: 15 * 60 })
        claimed = claim === "OK"
        if (!claimed) return
        if (!serverConfig.piApiKey) throw new Error("F1G Pi API authority unavailable")
        const candidateRows = await query(`
          SELECT r.id receipt_id,t.payment_id,r.a2u_identifier,r.a2u_txid,r.merchant_amount
          FROM receipts r JOIN transactions t ON t.id=r.transaction_id
          WHERE r.merchant_id='hazemaboria' AND r.settlement_status='completed'
            AND r.customer_amount IS NOT NULL AND r.merchant_amount IS NOT NULL
            AND r.u2a_identifier IS NOT NULL AND r.u2a_txid IS NOT NULL
            AND r.a2u_identifier IS NOT NULL AND r.a2u_txid IS NOT NULL
          ORDER BY r.id
        `)
        if (!Array.isArray(candidateRows) || candidateRows.length !== 3) throw new Error("F1G certified candidate set changed")
        const candidates = candidateRows.map((raw) => {
          if (!raw || typeof raw !== "object") throw new Error("F1G candidate shape invalid")
          const row = raw as Record<string, unknown>
          const merchantAmount = Number(row.merchant_amount)
          if (typeof row.receipt_id !== "string" || typeof row.payment_id !== "string" || typeof row.a2u_identifier !== "string" ||
              typeof row.a2u_txid !== "string" || !/^[0-9a-f]{64}$/.test(row.a2u_txid) || !Number.isFinite(merchantAmount) || merchantAmount <= 0)
            throw new Error("F1G candidate identity invalid")
          return { receiptId: row.receipt_id, paymentId: row.payment_id, a2uIdentifier: row.a2u_identifier, a2uTxid: row.a2u_txid, merchantAmount }
        })
        const candidateAmount = candidates.reduce((sum, row) => sum + row.merchantAmount, 0)
        if (Math.abs(candidateAmount - 3.2) > 1e-9) throw new Error("F1G certified candidate amount changed")

        for (const candidate of candidates) {
          const piResponse = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(candidate.a2uIdentifier)}`, {
            method: "GET", headers: { Authorization: `Key ${serverConfig.piApiKey}`, "Content-Type": "application/json" }, cache: "no-store",
          })
          if (!piResponse.ok) throw new Error(`F1G Pi authority unavailable (${piResponse.status})`)
          const dto = asRecord(await piResponse.json().catch(() => null))
          const status = dto ? asRecord(dto.status) : null
          const transaction = dto ? asRecord(dto.transaction) : null
          if (!dto || dto.identifier !== candidate.a2uIdentifier || dto.direction !== "app_to_user" || Number(dto.amount) !== candidate.merchantAmount ||
              transaction?.txid !== candidate.a2uTxid || status?.transaction_verified !== true || status?.developer_completed !== true ||
              status?.cancelled === true || status?.user_cancelled === true)
            throw new Error("F1G Pi movement identity not proven")

          const horizonResponse = await fetch(`https://api.testnet.minepi.com/transactions/${candidate.a2uTxid}`, { cache: "no-store" })
          if (!horizonResponse.ok) throw new Error(`F1G Horizon authority unavailable (${horizonResponse.status})`)
          const horizon = asRecord(await horizonResponse.json().catch(() => null))
          if (!horizon || horizon.hash !== candidate.a2uTxid || horizon.successful !== true)
            throw new Error("F1G Horizon transaction not proven")
          const operationsHref = asRecord(asRecord(horizon._links)?.operations)?.href
          const expectedOperationsUrl = `https://api.testnet.minepi.com/transactions/${candidate.a2uTxid}/operations`
          if (typeof operationsHref !== "string")
            throw new Error("F1G Horizon operations authority unavailable")
          const operationsUrl = operationsHref.replace(/\{[^}]*\}$/, "")
          if (operationsUrl !== expectedOperationsUrl)
            throw new Error("F1G Horizon operations authority mismatch")
          const operationsResponse = await fetch(expectedOperationsUrl, { cache: "no-store" })
          if (!operationsResponse.ok) throw new Error(`F1G Horizon operations unavailable (${operationsResponse.status})`)
          const operationsDto = asRecord(await operationsResponse.json().catch(() => null))
          const embedded = operationsDto ? asRecord(operationsDto._embedded) : null
          const records = embedded?.records
          if (!Array.isArray(records)) throw new Error("F1G Horizon operations shape invalid")
          const matchingPayments = records.filter((raw): raw is Record<string, unknown> => {
            const op = asRecord(raw)
            if (!op || op.type !== "payment" || op.transaction_hash !== candidate.a2uTxid) return false
            const amount = Number(op.amount)
            return Number.isFinite(amount) && Math.abs(amount - candidate.merchantAmount) <= 1e-9
          })
          if (matchingPayments.length !== 1) throw new Error("F1G Horizon payment amount not uniquely proven")
          const paymentOperation = matchingPayments[0]
          if (typeof paymentOperation.from !== "string" || typeof paymentOperation.to !== "string" || paymentOperation.from === paymentOperation.to)
            throw new Error("F1G Horizon payment endpoints invalid")
          if (typeof dto.from_address === "string" && paymentOperation.from !== dto.from_address)
            throw new Error("F1G Horizon source does not match Pi authority")
          if (typeof dto.to_address !== "string" || paymentOperation.to !== dto.to_address)
            throw new Error("F1G Horizon destination does not match Pi authority")
        }

        const repaired = await repairF1LegacyCompletedCanonicalReceipts({ merchantId: "hazemaboria", receipts: candidates, expectedCandidateAmount: 3.2 })
        if ("error" in repaired)
          throw new Error(`F1G DB repair blocked: ${repaired.error}`)
        const proof = await query(`
          SELECT b.settled stored_settled,
                 COALESCE(SUM(r.merchant_amount) FILTER (WHERE r.settlement_status='settled_to_merchant'),0) canonical_settled,
                 b.unsettled stored_unsettled,
                 COUNT(*) FILTER (WHERE r.settlement_status='completed' AND r.customer_amount IS NOT NULL AND r.merchant_amount IS NOT NULL AND r.a2u_identifier IS NOT NULL AND r.a2u_txid IS NOT NULL) canonical_completed_remaining
          FROM merchant_balances b LEFT JOIN receipts r ON r.merchant_id=b.merchant_id
          WHERE b.merchant_id='hazemaboria' GROUP BY b.merchant_id,b.settled,b.unsettled
        `)
        if (!Array.isArray(proof) || proof.length !== 1) throw new Error("F1G post-repair proof unavailable")
        const post = proof[0] as Record<string, unknown>
        if (Number(post.stored_settled) !== Number(post.canonical_settled) || Number(post.canonical_completed_remaining) !== 0)
          throw new Error("F1G post-repair settled invariant failed")
        console.log("[F1G GUARDED REPAIR] complete", { outcome: repaired.outcome, repairedCount: repaired.repairedCount, repairedAmount: repaired.repairedAmount, storedSettled: post.stored_settled, canonicalSettled: post.canonical_settled, storedUnsettled: post.stored_unsettled, externalAuthority: "Pi+Horizon", merchantBalanceMutation: false, legacyUnsettledMutation: false })
        await redis.set(F1_GUARDED_REPAIR_ONCE_KEY, "done", { ex: 30 * 24 * 60 * 60 })
      } catch (error) {
        if (claimed) { try { await redis.del(F1_GUARDED_REPAIR_ONCE_KEY) } catch {} }
        console.error("[F1G GUARDED REPAIR] failed", error instanceof Error ? error.message : String(error))
      }
    })
  } catch {}

  // F1H final legacy closure:
  // 1) zero only the obsolete pre-canonical `unsettled` materialization after proving every
  //    current settled balance already equals the canonical settled receipt sum;
  // 2) certify the single historical orphan against DB durable authorities + Pi.
  // It never creates/submits/completes/refunds any movement and never changes `settled`.
  try {
    after(async () => {
      let claimed = false
      try {
        const claim = await redis.set(F1_FINAL_LEGACY_CLOSURE_ONCE_KEY, "running", { nx: true, ex: 15 * 60 })
        claimed = claim === "OK"
        if (!claimed) return

        const repaired = await query(`
          WITH locked AS (
            SELECT merchant_id, settled, unsettled
            FROM merchant_balances
            WHERE unsettled <> 0
            ORDER BY merchant_id
            FOR UPDATE
          ),
          canonical AS (
            SELECT merchant_id,
                   COALESCE(SUM(merchant_amount) FILTER (WHERE settlement_status='settled_to_merchant'),0) canonical_settled
            FROM receipts
            GROUP BY merchant_id
          ),
          guard AS (
            SELECT COUNT(*)::int row_count,
                   COALESCE(SUM(l.unsettled),0) total_unsettled,
                   COUNT(*) FILTER (WHERE l.settled <> COALESCE(c.canonical_settled,0))::int settled_mismatch_count
            FROM locked l LEFT JOIN canonical c ON c.merchant_id=l.merchant_id
          ),
          updated AS (
            UPDATE merchant_balances b
            SET unsettled=0, last_updated=NOW()
            FROM guard g
            WHERE b.merchant_id IN (SELECT merchant_id FROM locked)
              AND g.row_count=27
              AND g.total_unsettled=139.60000000
              AND g.settled_mismatch_count=0
            RETURNING b.merchant_id
          )
          SELECT g.row_count,g.total_unsettled,g.settled_mismatch_count,
                 (SELECT COUNT(*)::int FROM updated) updated_count
          FROM guard g
        `)
        if (!Array.isArray(repaired) || repaired.length !== 1 || !repaired[0] || typeof repaired[0] !== "object")
          throw new Error("F1H legacy unsettled repair proof unavailable")
        const repairProof = repaired[0] as Record<string, unknown>
        if (Number(repairProof.row_count) !== 27 || Number(repairProof.total_unsettled) !== 139.6 ||
            Number(repairProof.settled_mismatch_count) !== 0 || Number(repairProof.updated_count) !== 27)
          throw new Error("F1H legacy unsettled repair guard rejected")

        const postRows = await query(`
          WITH canonical AS (
            SELECT merchant_id,
                   COALESCE(SUM(merchant_amount) FILTER (WHERE settlement_status='settled_to_merchant'),0) canonical_settled
            FROM receipts GROUP BY merchant_id
          ),
          all_merchants AS (
            SELECT merchant_id FROM merchant_balances UNION SELECT merchant_id FROM canonical
          )
          SELECT
            (SELECT COUNT(*)::int FROM merchant_balances WHERE unsettled<>0) nonzero_unsettled_count,
            (SELECT COALESCE(SUM(unsettled),0) FROM merchant_balances) total_unsettled,
            (SELECT COUNT(*)::int
             FROM all_merchants m
             LEFT JOIN merchant_balances b ON b.merchant_id=m.merchant_id
             LEFT JOIN canonical c ON c.merchant_id=m.merchant_id
             WHERE COALESCE(b.settled,0)<>COALESCE(c.canonical_settled,0)) settled_mismatch_count
        `)
        if (!Array.isArray(postRows) || postRows.length !== 1 || !postRows[0] || typeof postRows[0] !== "object")
          throw new Error("F1H post-repair proof unavailable")
        const post = postRows[0] as Record<string, unknown>
        if (Number(post.nonzero_unsettled_count) !== 0 || Number(post.total_unsettled) !== 0 || Number(post.settled_mismatch_count) !== 0)
          throw new Error("F1H post-repair accounting invariant failed")

        const orphanRows = await query(`
          SELECT t.id,t.payment_id,t.merchant_id,t.merchant_uid,t.amount,t.status,t.reference,t.created_at,t.completed_at,
                 (SELECT COUNT(*)::int FROM receipts r WHERE r.transaction_id=t.id) receipt_count,
                 (SELECT COUNT(*)::int FROM settlement_requests sr WHERE sr.transaction_id=t.id) settlement_request_count,
                 (SELECT COUNT(*)::int FROM settlement_checkpoints sc WHERE sc.payment_id=t.payment_id) settlement_checkpoint_count,
                 (SELECT COUNT(*)::int FROM refund_checkpoints rc WHERE rc.payment_id=t.payment_id) refund_checkpoint_count,
                 (SELECT COUNT(*)::int FROM refund_accounting_records ra WHERE ra.payment_id=t.payment_id) refund_accounting_count
          FROM transactions t
          LEFT JOIN receipts r ON r.transaction_id=t.id
          WHERE r.id IS NULL
          ORDER BY t.created_at
        `)
        if (!Array.isArray(orphanRows) || orphanRows.length !== 1 || !orphanRows[0] || typeof orphanRows[0] !== "object")
          throw new Error("F1H orphan identity changed")
        const orphan = orphanRows[0] as Record<string, unknown>
        if (orphan.id !== "8669e2bc-effc-4e76-8d24-d809025f2a92" ||
            orphan.payment_id !== "eQU604TLlEn2O86i00o5jUhM1HAD" ||
            orphan.merchant_id !== "mariamBoesha" || Number(orphan.amount) !== 0.1 ||
            Number(orphan.receipt_count) !== 0)
          throw new Error("F1H orphan certified identity mismatch")

        let piAuthority: Record<string, unknown> | null = null
        let piAuthorityStatus = 0
        if (serverConfig.piApiKey) {
          const piResponse = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(String(orphan.payment_id))}`, {
            method: "GET",
            headers: { Authorization: `Key ${serverConfig.piApiKey}`, "Content-Type": "application/json" },
            cache: "no-store",
          })
          piAuthorityStatus = piResponse.status
          if (piResponse.ok) piAuthority = asRecord(await piResponse.json().catch(() => null))
        }

        console.log("[F1H FINAL LEGACY CLOSURE] complete", {
          obsoleteUnsettledRowsCleared: Number(repairProof.updated_count),
          obsoleteUnsettledAmountCleared: Number(repairProof.total_unsettled),
          postNonzeroUnsettledCount: Number(post.nonzero_unsettled_count),
          postTotalUnsettled: Number(post.total_unsettled),
          postSettledMismatchCount: Number(post.settled_mismatch_count),
          merchantSettledMutation: false,
          blockchainMovement: false,
          orphan: {
            id: orphan.id,
            paymentId: orphan.payment_id,
            merchantId: orphan.merchant_id,
            amount: Number(orphan.amount),
            status: orphan.status,
            receiptCount: Number(orphan.receipt_count),
            settlementRequestCount: Number(orphan.settlement_request_count),
            settlementCheckpointCount: Number(orphan.settlement_checkpoint_count),
            refundCheckpointCount: Number(orphan.refund_checkpoint_count),
            refundAccountingCount: Number(orphan.refund_accounting_count),
            piAuthorityStatus,
            piIdentifier: piAuthority?.identifier ?? null,
            piDirection: piAuthority?.direction ?? null,
            piAmount: piAuthority?.amount ?? null,
            piStatus: piAuthority ? asRecord(piAuthority.status) : null,
            piTransaction: piAuthority ? asRecord(piAuthority.transaction) : null,
          },
          orphanMutation: false,
        })
        await redis.set(F1_FINAL_LEGACY_CLOSURE_ONCE_KEY, "done", { ex: 30 * 24 * 60 * 60 })
      } catch (error) {
        if (claimed) { try { await redis.del(F1_FINAL_LEGACY_CLOSURE_ONCE_KEY) } catch {} }
        console.error("[F1H FINAL LEGACY CLOSURE] failed", error instanceof Error ? error.message : String(error))
      }
    })
  } catch {}

  // F1 orphan forensic proof (read-only): independently correlate the historical 0.1 Pi U2A
  // against Pi + Horizon + PostgreSQL. It never creates/submits/completes/refunds a payment,
  // and it never mutates PostgreSQL accounting or merchant balances.
  try {
    after(async () => {
      let claimed = false
      try {
        const claim = await redis.set(F1_ORPHAN_FORENSIC_PROOF_ONCE_KEY, "running", { nx: true, ex: 15 * 60 })
        claimed = claim === "OK"
        if (!claimed) return
        if (!serverConfig.piApiKey) throw new Error("F1 orphan proof Pi API key unavailable")

        const orphanPaymentId = "eQU604TLlEn2O86i00o5jUhM1HAD"
        const orphanTxid = "f1eeef175d5f301f5f0a60ccb49507e49926e8df590e3ff5f8e3f376096956a3"
        const orphanMerchantId = "mariamBoesha"
        const orphanAmount = "0.1000000"
        const horizonBase = "https://api.testnet.minepi.com"

        const piResponse = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(orphanPaymentId)}`, {
          method: "GET", headers: { Authorization: `Key ${serverConfig.piApiKey}`, Accept: "application/json" }, cache: "no-store", redirect: "error",
        })
        if (!piResponse.ok) throw new Error(`F1 orphan proof Pi U2A HTTP ${piResponse.status}`)
        const piU2A = asRecord(await piResponse.json().catch(() => null))
        const piStatus = piU2A ? asRecord(piU2A.status) : null
        const piTransaction = piU2A ? asRecord(piU2A.transaction) : null
        const piUser = piU2A ? asRecord(piU2A.user) : null
        const payerUid = typeof piU2A?.user_uid === "string" ? piU2A.user_uid : typeof piUser?.uid === "string" ? piUser.uid : null
        if (!piU2A || piU2A.identifier !== orphanPaymentId || piU2A.direction !== "user_to_app" || Number(piU2A.amount) !== 0.1 ||
            piTransaction?.txid !== orphanTxid || piStatus?.transaction_verified !== true || piStatus?.developer_completed !== true ||
            piStatus?.cancelled === true || piStatus?.user_cancelled === true || !payerUid)
          throw new Error("F1 orphan proof Pi U2A authority mismatch")

        const txResponse = await fetch(`${horizonBase}/transactions/${orphanTxid}`, { cache: "no-store", redirect: "error" })
        if (!txResponse.ok) throw new Error(`F1 orphan proof Horizon U2A tx HTTP ${txResponse.status}`)
        const horizonTx = asRecord(await txResponse.json().catch(() => null))
        if (!horizonTx || horizonTx.hash !== orphanTxid || horizonTx.successful !== true) throw new Error("F1 orphan proof Horizon U2A tx mismatch")
        const txLinks = asRecord(horizonTx._links)
        const opsLink = txLinks ? asRecord(txLinks.operations) : null
        const rawOpsHref = typeof opsLink?.href === "string" ? opsLink.href : ""
        const opsHref = rawOpsHref.replace(/\{[^}]*\}$/, "")
        const expectedOpsHref = `${horizonBase}/transactions/${orphanTxid}/operations`
        if (opsHref !== expectedOpsHref) throw new Error("F1 orphan proof Horizon operations link mismatch")
        const opsResponse = await fetch(opsHref, { cache: "no-store", redirect: "error" })
        if (!opsResponse.ok) throw new Error(`F1 orphan proof Horizon U2A ops HTTP ${opsResponse.status}`)
        const opsBody = asRecord(await opsResponse.json().catch(() => null))
        const embedded = opsBody ? asRecord(opsBody._embedded) : null
        const u2aOps = embedded && Array.isArray(embedded.records) ? embedded.records.map(asRecord).filter((v): v is Record<string, unknown> => v !== null) : []
        const u2aPaymentOps = u2aOps.filter((op) => op.type === "payment" && op.asset_type === "native" && op.amount === orphanAmount)
        if (u2aPaymentOps.length !== 1) throw new Error("F1 orphan proof Horizon U2A payment operation mismatch")
        const u2aOp = u2aPaymentOps[0]
        const payerAddress = typeof u2aOp.from === "string" ? u2aOp.from : null
        const appAddress = typeof u2aOp.to === "string" ? u2aOp.to : null
        if (!payerAddress || !appAddress || payerAddress === appAddress) throw new Error("F1 orphan proof U2A addresses unavailable")

        const dbRows = await query(`
          SELECT t.id,t.payment_id,t.merchant_id,t.merchant_uid,t.amount,t.status,t.created_at,t.completed_at,
                 (SELECT COUNT(*)::int FROM receipts r WHERE r.transaction_id=t.id) receipt_count,
                 (SELECT COUNT(*)::int FROM settlement_requests sr WHERE sr.transaction_id=t.id) settlement_request_count,
                 (SELECT COUNT(*)::int FROM settlement_checkpoints sc WHERE sc.payment_id=t.payment_id) settlement_checkpoint_count,
                 (SELECT COUNT(*)::int FROM refund_checkpoints rc WHERE rc.payment_id=t.payment_id) refund_checkpoint_count,
                 (SELECT COUNT(*)::int FROM refund_accounting_records ra WHERE ra.payment_id=t.payment_id) refund_accounting_count
          FROM transactions t WHERE t.payment_id=$1
        `, [orphanPaymentId])
        if (!Array.isArray(dbRows) || dbRows.length !== 1 || !dbRows[0] || typeof dbRows[0] !== "object") throw new Error("F1 orphan proof DB identity unavailable")
        const db = dbRows[0] as Record<string, unknown>
        if (db.merchant_id !== orphanMerchantId || Number(db.amount) !== 0.1 || Number(db.receipt_count) !== 0) throw new Error("F1 orphan proof DB identity mismatch")

        // Search the app account's subsequent successful transactions. A candidate is not accepted merely
        // because it is 0.1 Pi: its memo must resolve to a Pi A2U whose authoritative payer UID/amount/direction
        // matches this U2A, and refund metadata must bind back to this exact payment for REFUNDED_TO_PAYER.
        const u2aLedger = typeof horizonTx.ledger === "number" ? horizonTx.ledger : null
        if (!u2aLedger) throw new Error("F1 orphan proof U2A ledger unavailable")
        const u2aPagingToken = typeof horizonTx.paging_token === "string" && horizonTx.paging_token.length > 0 ? horizonTx.paging_token : null
        if (!u2aPagingToken) throw new Error("F1 orphan proof U2A paging token unavailable")
        let nextUrl: string | null = `${horizonBase}/accounts/${encodeURIComponent(appAddress)}/transactions?order=asc&limit=200&cursor=${encodeURIComponent(u2aPagingToken)}`
        const outboundCandidates: Array<Record<string, unknown>> = []
        let pages = 0
        while (nextUrl && pages < 25) {
          pages++
          const pageResponse = await fetch(nextUrl, { cache: "no-store", redirect: "error" })
          if (!pageResponse.ok) throw new Error(`F1 orphan proof Horizon account page HTTP ${pageResponse.status}`)
          const pageBody = asRecord(await pageResponse.json().catch(() => null))
          const pageEmbedded = pageBody ? asRecord(pageBody._embedded) : null
          const records = pageEmbedded && Array.isArray(pageEmbedded.records) ? pageEmbedded.records.map(asRecord).filter((v): v is Record<string, unknown> => v !== null) : []
          for (const candidateTx of records) {
            const ledger = typeof candidateTx.ledger === "number" ? candidateTx.ledger : null
            if (!ledger || ledger <= u2aLedger || candidateTx.successful !== true || typeof candidateTx.hash !== "string") continue
            const createdAt = typeof candidateTx.created_at === "string" ? Date.parse(candidateTx.created_at) : NaN
            const u2aCreatedAt = typeof horizonTx.created_at === "string" ? Date.parse(horizonTx.created_at) : NaN
            if (!Number.isFinite(createdAt) || !Number.isFinite(u2aCreatedAt) || createdAt - u2aCreatedAt > 30 * 24 * 60 * 60_000) continue
            const candidateHash = candidateTx.hash
            const candidateOpsResponse = await fetch(`${horizonBase}/transactions/${candidateHash}/operations`, { cache: "no-store", redirect: "error" })
            if (!candidateOpsResponse.ok) throw new Error(`F1 orphan proof Horizon candidate ops HTTP ${candidateOpsResponse.status}`)
            const candidateOpsBody = asRecord(await candidateOpsResponse.json().catch(() => null))
            const candidateEmbedded = candidateOpsBody ? asRecord(candidateOpsBody._embedded) : null
            const candidateOps = candidateEmbedded && Array.isArray(candidateEmbedded.records) ? candidateEmbedded.records.map(asRecord).filter((v): v is Record<string, unknown> => v !== null) : []
            const exactReturn = candidateOps.find((op) => op.type === "payment" && op.asset_type === "native" && op.from === appAddress && op.to === payerAddress && op.amount === orphanAmount)
            if (!exactReturn) continue
            const memo = candidateTx.memo_type === "text" && typeof candidateTx.memo === "string" && candidateTx.memo.trim() === candidateTx.memo ? candidateTx.memo : null
            let piA2U: Record<string, unknown> | null = null
            if (memo) {
              const candidatePiResponse = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(memo)}`, {
                method: "GET", headers: { Authorization: `Key ${serverConfig.piApiKey}`, Accept: "application/json" }, cache: "no-store", redirect: "error",
              })
              if (candidatePiResponse.ok) piA2U = asRecord(await candidatePiResponse.json().catch(() => null))
            }
            const candidateMetadata = piA2U ? asRecord(piA2U.metadata) : null
            const candidateStatus = piA2U ? asRecord(piA2U.status) : null
            const candidateTransaction = piA2U ? asRecord(piA2U.transaction) : null
            const candidateUser = piA2U ? asRecord(piA2U.user) : null
            const candidateUid = typeof piA2U?.user_uid === "string" ? piA2U.user_uid : typeof candidateUser?.uid === "string" ? candidateUser.uid : null
            const piExact = !!piA2U && piA2U.identifier === memo && piA2U.direction === "app_to_user" && Number(piA2U.amount) === 0.1 && candidateUid === payerUid &&
              candidateTransaction?.txid === candidateHash && candidateStatus?.transaction_verified === true && candidateStatus?.developer_completed === true &&
              candidateStatus?.cancelled !== true && candidateStatus?.user_cancelled !== true
            const refundExact = piExact && candidateMetadata?.type === "refund" && candidateMetadata?.paymentId === orphanPaymentId
            outboundCandidates.push({ txid: candidateHash, memo, piIdentifier: piA2U?.identifier ?? null, piExact, refundExact, metadata: candidateMetadata })
          }
          const links = pageBody ? asRecord(pageBody._links) : null
          const next = links ? asRecord(links.next) : null
          const href = typeof next?.href === "string" ? next.href : null
          if (!href || records.length < 200) nextUrl = null
          else if (!href.startsWith(`${horizonBase}/`)) throw new Error("F1 orphan proof Horizon pagination origin mismatch")
          else nextUrl = href
        }

        const exactRefunds = outboundCandidates.filter((candidate) => candidate.refundExact === true)
        const exactPiReturns = outboundCandidates.filter((candidate) => candidate.piExact === true)
        const verdict = exactRefunds.length === 1 ? "REFUNDED_TO_PAYER" : exactRefunds.length > 1 ? "INDETERMINATE" : exactPiReturns.length > 0 ? "INDETERMINATE" : "NO_REFUND_PROVEN"

        const finalRows = await query(`
          WITH canonical AS (
            SELECT merchant_id,COALESCE(SUM(merchant_amount) FILTER (WHERE settlement_status='settled_to_merchant'),0) canonical_settled
            FROM receipts GROUP BY merchant_id
          ), all_merchants AS (
            SELECT merchant_id FROM merchant_balances UNION SELECT merchant_id FROM canonical
          )
          SELECT
            (SELECT COUNT(*)::int FROM merchant_balances WHERE unsettled<>0) nonzero_unsettled_count,
            (SELECT COALESCE(SUM(unsettled),0) FROM merchant_balances) total_unsettled,
            (SELECT COUNT(*)::int FROM all_merchants m LEFT JOIN merchant_balances b ON b.merchant_id=m.merchant_id LEFT JOIN canonical c ON c.merchant_id=m.merchant_id WHERE COALESCE(b.settled,0)<>COALESCE(c.canonical_settled,0)) settled_mismatch_count,
            (SELECT COUNT(*)::int FROM (SELECT payment_id FROM transactions GROUP BY payment_id HAVING COUNT(*)>1) d) duplicate_payment_id_count,
            (SELECT COUNT(*)::int FROM (SELECT transaction_id FROM receipts GROUP BY transaction_id HAVING COUNT(*)>1) d) duplicate_receipt_transaction_id_count,
            (SELECT COUNT(*)::int FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id WHERE r.id IS NULL) orphan_transaction_count
        `)
        if (!Array.isArray(finalRows) || finalRows.length !== 1 || !finalRows[0] || typeof finalRows[0] !== "object") throw new Error("F1 final accounting proof unavailable")
        const final = finalRows[0] as Record<string, unknown>

        console.log("[F1 ORPHAN FORENSIC PROOF] complete", {
          verdict,
          orphanPaymentId,
          orphanU2aTxid: orphanTxid,
          amount: 0.1,
          merchantId: orphanMerchantId,
          payerUid,
          payerAddress,
          appAddress,
          horizonU2aLedger: u2aLedger,
          searchedPages: pages,
          exactReturnCandidateCount: outboundCandidates.length,
          exactPiReturnCount: exactPiReturns.length,
          exactRefundCount: exactRefunds.length,
          candidates: outboundCandidates,
          db: {
            receiptCount: Number(db.receipt_count), settlementRequestCount: Number(db.settlement_request_count),
            settlementCheckpointCount: Number(db.settlement_checkpoint_count), refundCheckpointCount: Number(db.refund_checkpoint_count),
            refundAccountingCount: Number(db.refund_accounting_count),
          },
          finalAccounting: {
            nonzeroUnsettledCount: Number(final.nonzero_unsettled_count), totalUnsettled: Number(final.total_unsettled),
            settledMismatchCount: Number(final.settled_mismatch_count), duplicatePaymentIdCount: Number(final.duplicate_payment_id_count),
            duplicateReceiptTransactionIdCount: Number(final.duplicate_receipt_transaction_id_count), orphanTransactionCount: Number(final.orphan_transaction_count),
          },
          financialMutation: false,
          blockchainMovement: false,
        })
        await redis.set(F1_ORPHAN_FORENSIC_PROOF_ONCE_KEY, "done", { ex: 30 * 24 * 60 * 60 })
      } catch (error) {
        if (claimed) { try { await redis.del(F1_ORPHAN_FORENSIC_PROOF_ONCE_KEY) } catch {} }
        console.error("[F1 ORPHAN FORENSIC PROOF] failed", error instanceof Error ? error.message : String(error))
      }
    })
  } catch {}

  // F1 final merchant-accounting certification (read-only): classify the one exact pre-canonical
  // historical U2A as a legacy exception without deleting it, inventing a receipt, crediting a merchant,
  // refunding a payer, or changing any financial state. This closes only F1 merchant-accounting scope;
  // it is not Plan N-FIN final certification and makes no claim about the historical movement's destination.
  try {
    after(async () => {
      let claimed = false
      try {
        const claim = await redis.set(F1_FINAL_ACCOUNTING_CERT_ONCE_KEY, "running", { nx: true, ex: 15 * 60 })
        claimed = claim === "OK"
        if (!claimed) return
        if (!serverConfig.piApiKey) throw new Error("F1 final cert Pi API key unavailable")

        const legacy = {
          transactionId: "8669e2bc-effc-4e76-8d24-d809025f2a92",
          paymentId: "eQU604TLlEn2O86i00o5jUhM1HAD",
          merchantId: "mariamBoesha",
          amount: 0.1,
          u2aTxid: "f1eeef175d5f301f5f0a60ccb49507e49926e8df590e3ff5f8e3f376096956a3",
        } as const

        const legacyRows = await query(`
          SELECT t.id,t.payment_id,t.merchant_id,t.amount,t.status,t.created_at,t.completed_at,
                 (SELECT COUNT(*)::int FROM receipts r WHERE r.transaction_id=t.id) receipt_count,
                 (SELECT COUNT(*)::int FROM settlement_requests sr WHERE sr.transaction_id=t.id) settlement_request_count,
                 (SELECT COUNT(*)::int FROM settlement_checkpoints sc WHERE sc.payment_id=t.payment_id) settlement_checkpoint_count,
                 (SELECT COUNT(*)::int FROM refund_checkpoints rc WHERE rc.payment_id=t.payment_id) refund_checkpoint_count,
                 (SELECT COUNT(*)::int FROM refund_accounting_records ra WHERE ra.payment_id=t.payment_id) refund_accounting_count
          FROM transactions t WHERE t.id=$1 AND t.payment_id=$2
        `, [legacy.transactionId, legacy.paymentId])
        if (!Array.isArray(legacyRows) || legacyRows.length !== 1 || !legacyRows[0] || typeof legacyRows[0] !== "object")
          throw new Error("F1 final cert legacy identity unavailable")
        const legacyDb = legacyRows[0] as Record<string, unknown>
        const createdAtValue = legacyDb.created_at
        const createdAtMs = createdAtValue instanceof Date ? createdAtValue.getTime() : typeof createdAtValue === "string" ? Date.parse(createdAtValue) : NaN
        const preCanonicalCutoffMs = Date.parse("2026-07-01T00:00:00.000Z")
        const noCanonicalDurableRecords = Number(legacyDb.receipt_count) === 0 && Number(legacyDb.settlement_request_count) === 0 &&
          Number(legacyDb.settlement_checkpoint_count) === 0 && Number(legacyDb.refund_checkpoint_count) === 0 && Number(legacyDb.refund_accounting_count) === 0
        if (legacyDb.merchant_id !== legacy.merchantId || Number(legacyDb.amount) !== legacy.amount || legacyDb.status !== "completed" ||
            !Number.isFinite(createdAtMs) || createdAtMs >= preCanonicalCutoffMs || !noCanonicalDurableRecords)
          throw new Error("F1 final cert legacy classification guard rejected")

        const piResponse = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(legacy.paymentId)}`, {
          method: "GET", headers: { Authorization: `Key ${serverConfig.piApiKey}`, Accept: "application/json" }, cache: "no-store", redirect: "error",
        })
        if (!piResponse.ok) throw new Error(`F1 final cert Pi authority HTTP ${piResponse.status}`)
        const piPayment = asRecord(await piResponse.json().catch(() => null))
        const piStatus = piPayment ? asRecord(piPayment.status) : null
        const piTransaction = piPayment ? asRecord(piPayment.transaction) : null
        if (!piPayment || piPayment.identifier !== legacy.paymentId || piPayment.direction !== "user_to_app" || Number(piPayment.amount) !== legacy.amount ||
            piTransaction?.txid !== legacy.u2aTxid || piStatus?.transaction_verified !== true || piStatus?.developer_completed !== true ||
            piStatus?.cancelled === true || piStatus?.user_cancelled === true)
          throw new Error("F1 final cert Pi authority mismatch")

        const certRows = await query(`
          WITH canonical AS (
            SELECT merchant_id,COALESCE(SUM(merchant_amount) FILTER (WHERE settlement_status='settled_to_merchant'),0) canonical_settled
            FROM receipts GROUP BY merchant_id
          ), all_merchants AS (
            SELECT merchant_id FROM merchant_balances UNION SELECT merchant_id FROM canonical
          ), orphans AS (
            SELECT t.id,t.payment_id FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id WHERE r.id IS NULL
          ), refund_overlap AS (
            SELECT ra.payment_id
            FROM refund_accounting_records ra
            JOIN transactions t ON t.payment_id=ra.payment_id
            JOIN receipts r ON r.transaction_id=t.id
            WHERE r.settlement_status='settled_to_merchant'
          )
          SELECT
            (SELECT COUNT(*)::int FROM merchant_balances WHERE unsettled<>0) nonzero_unsettled_count,
            (SELECT COALESCE(SUM(unsettled),0) FROM merchant_balances) total_unsettled,
            (SELECT COUNT(*)::int FROM all_merchants m LEFT JOIN merchant_balances b ON b.merchant_id=m.merchant_id LEFT JOIN canonical c ON c.merchant_id=m.merchant_id WHERE COALESCE(b.settled,0)<>COALESCE(c.canonical_settled,0)) settled_mismatch_count,
            (SELECT COUNT(*)::int FROM (SELECT payment_id FROM transactions GROUP BY payment_id HAVING COUNT(*)>1) d) duplicate_payment_id_count,
            (SELECT COUNT(*)::int FROM (SELECT transaction_id FROM receipts GROUP BY transaction_id HAVING COUNT(*)>1) d) duplicate_receipt_transaction_id_count,
            (SELECT COUNT(*)::int FROM (SELECT a2u_identifier FROM receipts WHERE a2u_identifier IS NOT NULL GROUP BY a2u_identifier HAVING COUNT(*)>1) d) duplicate_a2u_identifier_count,
            (SELECT COUNT(*)::int FROM (SELECT a2u_txid FROM receipts WHERE a2u_txid IS NOT NULL GROUP BY a2u_txid HAVING COUNT(*)>1) d) duplicate_a2u_txid_count,
            (SELECT COUNT(*)::int FROM refund_overlap) refund_settled_overlap_count,
            (SELECT COUNT(*)::int FROM orphans) raw_orphan_count,
            (SELECT COUNT(*)::int FROM orphans WHERE id=$1 AND payment_id=$2) classified_legacy_orphan_count,
            (SELECT COUNT(*)::int FROM orphans WHERE NOT (id=$1 AND payment_id=$2)) unclassified_orphan_count
        `, [legacy.transactionId, legacy.paymentId])
        if (!Array.isArray(certRows) || certRows.length !== 1 || !certRows[0] || typeof certRows[0] !== "object")
          throw new Error("F1 final cert accounting proof unavailable")
        const cert = certRows[0] as Record<string, unknown>
        const pass = Number(cert.nonzero_unsettled_count) === 0 && Number(cert.total_unsettled) === 0 && Number(cert.settled_mismatch_count) === 0 &&
          Number(cert.duplicate_payment_id_count) === 0 && Number(cert.duplicate_receipt_transaction_id_count) === 0 &&
          Number(cert.duplicate_a2u_identifier_count) === 0 && Number(cert.duplicate_a2u_txid_count) === 0 && Number(cert.refund_settled_overlap_count) === 0 &&
          Number(cert.raw_orphan_count) === 1 && Number(cert.classified_legacy_orphan_count) === 1 && Number(cert.unclassified_orphan_count) === 0
        if (!pass) throw new Error("F1 final cert invariant rejected")

        console.log("[F1 FINAL MERCHANT ACCOUNTING CERT] complete", {
          verdict: "FULL_PASS_WITH_CLASSIFIED_LEGACY_EXCEPTION",
          scope: "F1_MERCHANT_ACCOUNTING_ONLY",
          planNFinFinalCertification: false,
          legacyClassification: {
            classification: "LEGACY_PRE_CANONICAL_U2A",
            transactionId: legacy.transactionId,
            paymentId: legacy.paymentId,
            merchantId: legacy.merchantId,
            amount: legacy.amount,
            u2aTxid: legacy.u2aTxid,
            piVerified: true,
            canonicalReceiptCreated: false,
            merchantBalanceCreditedByClassification: false,
            refundCreatedByClassification: false,
            blockchainMovementCreatedByClassification: false,
            historicalMovementDestinationClaim: "NOT_ASSERTED",
          },
          accounting: {
            nonzeroUnsettledCount: Number(cert.nonzero_unsettled_count), totalUnsettled: Number(cert.total_unsettled),
            settledMismatchCount: Number(cert.settled_mismatch_count), duplicatePaymentIdCount: Number(cert.duplicate_payment_id_count),
            duplicateReceiptTransactionIdCount: Number(cert.duplicate_receipt_transaction_id_count), duplicateA2uIdentifierCount: Number(cert.duplicate_a2u_identifier_count),
            duplicateA2uTxidCount: Number(cert.duplicate_a2u_txid_count), refundSettledOverlapCount: Number(cert.refund_settled_overlap_count),
            rawOrphanCount: Number(cert.raw_orphan_count), classifiedLegacyOrphanCount: Number(cert.classified_legacy_orphan_count),
            unclassifiedOrphanCount: Number(cert.unclassified_orphan_count),
          },
          financialMutation: false,
          blockchainMovement: false,
        })
        await redis.set(F1_FINAL_ACCOUNTING_CERT_ONCE_KEY, "done", { ex: 30 * 24 * 60 * 60 })
      } catch (error) {
        if (claimed) { try { await redis.del(F1_FINAL_ACCOUNTING_CERT_ONCE_KEY) } catch {} }
        console.error("[F1 FINAL MERCHANT ACCOUNTING CERT] failed", error instanceof Error ? error.message : String(error))
      }
    })
  } catch {}

  // M7 telemetry only: schedule best-effort freshness evidence after trusted authentication.
  // It must never block, authorize, or alter financial recovery execution.
  try {
    after(async () => { try { await redis.set(RECOVERY_WAKE_HEALTH_KEY, new Date().toISOString(), { ex: 7 * 24 * 60 * 60 }) } catch {} })
  } catch {}

  const requestedMode = new URL(request.url).searchParams.get("mode")
  if (requestedMode === CONTINUATION_MODE) {
    const scheduled = scheduleTrustedTransientRequest("drain")
    return NextResponse.json({ state: scheduled ? "continuation_scheduled" : "continuation_unavailable" }, { status: scheduled ? 202 : 503 })
  }
  if (requestedMode !== null && requestedMode !== IMMEDIATE_DRAIN_MODE) return NextResponse.json({ error: "Invalid transient recovery mode" }, { status: 400 })
  const immediateDrainMode = requestedMode === IMMEDIATE_DRAIN_MODE

  const drainLease = await acquireTransientDrainLease()
  if (drainLease.state === "unavailable") return NextResponse.json({ error: "Transient drain lease unavailable" }, { status: 503 })
  if (drainLease.state === "busy") {
    console.log("[P7J5 LEASE] overlap blocked")
    return NextResponse.json({ processed: 0, state: "overlap_blocked" })
  }

  console.log("[P7J5 LEASE] acquired")
  try {
  const initialPiCreateBackpressure = await readPiCreateBackpressure(Date.now())
  let piCreateBackpressureUnavailable = initialPiCreateBackpressure.state === "unavailable"
  let piCreateBackpressureUntilMs = initialPiCreateBackpressure.state === "active" ? initialPiCreateBackpressure.untilMs : null
  const piCreateBackpressureActive = () => piCreateBackpressureUnavailable || (piCreateBackpressureUntilMs !== null && piCreateBackpressureUntilMs > Date.now())
  const registerPiCreateBackpressure = async (payment: Payment) => {
    if (!isPiCreateBackpressureSignal(payment)) return false
    const observedAt = Date.now()
    const parsedRetryAt = typeof payment.nextRetryAt === "string" && payment.nextRetryAt.trim() !== "" && payment.nextRetryAt === payment.nextRetryAt.trim() ? Date.parse(payment.nextRetryAt) : NaN
    const localUntil = Math.max(observedAt + PI_CREATE_BACKPRESSURE_FALLBACK_MS, Number.isFinite(parsedRetryAt) && parsedRetryAt > observedAt ? parsedRetryAt : 0)
    piCreateBackpressureUntilMs = piCreateBackpressureUntilMs === null ? localUntil : Math.max(piCreateBackpressureUntilMs, localUntil)
    const extended = await extendPiCreateBackpressure(payment.nextRetryAt, observedAt)
    if (extended === null) {
      piCreateBackpressureUnavailable = true
    } else {
      piCreateBackpressureUntilMs = Math.max(piCreateBackpressureUntilMs, extended)
    }
    return true
  }
  const wakeStartedAt = Date.now()
  const discoveryStartedAt = Date.now()
  let keys: string[]
  let activeSetSize = 0
  let scanStartToken = "c:0"
  let scanNextToken = "c:0"
  // N-FIN-10F + F2-3: periodic wake repairs both Stage1+ Settlement work and
  // verified pre-A2U U2A ingress from PostgreSQL authority. F2-3 performs no
  // Pi/Horizon/Settlement/Refund movement; fully lost Redis projections remain
  // execution-deferred until F2-4 removes the access-token dependency.
  let durableU2AIngressRepopulation:DurableU2AIngressRepopulation
  try {
    await repopulateDurableSettlementWork()
    durableU2AIngressRepopulation=await repopulateDurableU2AIngressWork()
  } catch {
    return NextResponse.json({ error: "Durable financial work repopulation unavailable" }, { status: 503 })
  }
  console.log("[F2-3 DURABLE REDISCOVERY]", durableU2AIngressRepopulation)

  let readyBaselineAlreadyCertified = false
  let readyBaselineCoverageCertified = false
  try {
    const markers = await Promise.all([
      redis.get("flashpay:recovery:active-payments:v1:bootstrap"),
      redis.get("flashpay:recovery:active-payments:v1:prune-pending"),
      redis.get("flashpay:recovery:active-payments:v1:prune-final-settlement"),
    ])
    if (markers.some((marker) => marker !== "done")) return NextResponse.json({ error: "Active recovery index not ready" }, { status: 503 })

    const storedCursor = await redis.get("flashpay:recovery:active-payments:v1:scan-cursor")
    if (storedCursor !== null && (typeof storedCursor !== "string" || !/^c:[0-9]+$/.test(storedCursor))) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
    const [storedReadyBaseline, storedReadyBaselineCoverage] = await Promise.all([
      redis.get("flashpay:settlement:ready:v1:authority-baseline"),
      redis.get(READY_BASELINE_COVERAGE_KEY),
    ])
    if (storedReadyBaseline !== null && storedReadyBaseline !== "done") return NextResponse.json({ error: "Settlement ready authority unavailable" }, { status: 503 })
    if (storedReadyBaselineCoverage !== null && storedReadyBaselineCoverage !== "done") return NextResponse.json({ error: "Settlement ready authority unavailable" }, { status: 503 })
    readyBaselineAlreadyCertified = storedReadyBaseline === "done"
    readyBaselineCoverageCertified = readyBaselineAlreadyCertified || storedReadyBaselineCoverage === "done"
    scanStartToken = storedCursor ?? "c:0"
    if (!readyBaselineCoverageCertified && scanStartToken === "c:0") {
      try { await redis.del(READY_BASELINE_SCAN_SEEN_KEY) } catch { return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 }) }
    }
    let pageCursor = scanStartToken.slice(2)
    const activePaymentIds: string[] = []
    const seenActivePaymentIds = new Set<string>()
    for (let page = 0; page < 4; page += 1) {
      const scanResult = await redis.sscan("flashpay:recovery:active-payments:v1", pageCursor, { count: 200 })
      if (!Array.isArray(scanResult) || scanResult.length !== 2) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
      const [nextCursor, members] = scanResult
      if (typeof nextCursor !== "string" || !/^[0-9]+$/.test(nextCursor) || !Array.isArray(members)) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
      for (const member of members) {
        if (typeof member !== "string" || member.length === 0 || member !== member.trim()) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
        if (!seenActivePaymentIds.has(member)) {
          seenActivePaymentIds.add(member)
          activePaymentIds.push(member)
        }
      }
      pageCursor = nextCursor
      scanNextToken = `c:${nextCursor}`
      if (nextCursor === "0") break
    }
    activeSetSize = Number(await redis.scard("flashpay:recovery:active-payments:v1"))
    keys = activePaymentIds.map((paymentId) => `payment:${paymentId}`)
  } catch {
    return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
  }
  const readyResidencyIds: string[] = []
  let readyResidencyCount: number | null = null
  let readyResidencyMissing: number | null = null
  let readyResidencySourceValid = true
  const postHorizonIds: string[] = []
  const preparedSubmitIds: string[] = []
  const retryableIds: string[] = []
  const freshDispatchIds: string[] = []
  const settlementReconcilingDiscoveryIds: string[] = []
  const staleRetryReconcilingDiscoveryIds: string[] = []
  const refundCandidateIds: string[] = []
  const now = Date.now()

  for (let index = 0; index < keys.length; index += 200) {
    const batchKeys = keys.slice(index, index + 200)
    let values: unknown[]
    try {
      const batchValues = await redis.mget<unknown[]>(batchKeys)
      if (!Array.isArray(batchValues) || batchValues.length !== batchKeys.length) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
      values = batchValues
    } catch {
      return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
    }

    for (let valueIndex = 0; valueIndex < batchKeys.length; valueIndex += 1) {
      const key = batchKeys[valueIndex]
      const payment = parsePayment(values[valueIndex])
      if (!payment) {
        readyResidencySourceValid = false
        continue
      }

      const paymentId = key.slice("payment:".length)
      if (payment.id === paymentId && checkRefundEligibility(payment)) {
        refundCandidateIds.push(paymentId)
      }
      if (payment.id !== paymentId) {
        readyResidencySourceValid = false
        continue
      }
      if ((payment.status === "paid_to_app" || payment.status === "settlement_pending") && !hasExcludedState(payment)) readyResidencyIds.push(paymentId)
      if (isFreshSettlementDispatchCandidate(payment, now) || isStage1OnlySettlementDispatchCandidate(payment, now)) freshDispatchIds.push(paymentId)
      if (isStaleFreshReconcilingCandidate(payment, now)) settlementReconcilingDiscoveryIds.push(paymentId)
      if (isStaleRetryReconcilingCandidate(payment, now)) staleRetryReconcilingDiscoveryIds.push(paymentId)
      if (isPostHorizonEligible(payment, now)) {
        postHorizonIds.push(paymentId)
      } else if (isPreparedSubmitEligible(payment)) {
        preparedSubmitIds.push(paymentId)
      } else if (isEligible(payment, now)) {
        retryableIds.push(paymentId)
      }
    }
  }
  const readyCoverageAllIds = [...new Set([...postHorizonIds, ...preparedSubmitIds, ...retryableIds, ...freshDispatchIds, ...settlementReconcilingDiscoveryIds, ...staleRetryReconcilingDiscoveryIds])]
  const readyCoverageTruncated = readyCoverageAllIds.length > 800
  let readyCoverageIndexed: number | null = null
  let readyCoverageMissing: number | null = null
  if (readyCoverageTruncated) {
    console.warn("[P7H CAPACITY] settlement ready coverage truncated")
  } else {
    try {
      let indexed = 0
      let missing = 0
      for (let batchStart = 0; batchStart < readyCoverageAllIds.length; batchStart += 200) {
        const batch = readyCoverageAllIds.slice(batchStart, batchStart + 200)
        const scores = await redis.zmscore("flashpay:settlement:ready:v1", batch)
        if (!Array.isArray(scores) || scores.length !== batch.length || scores.some((score) => score !== null && (typeof score !== "number" || !Number.isSafeInteger(score) || score < 0))) throw new Error("Invalid settlement ready coverage")
        indexed += scores.filter((score) => score !== null).length
        missing += scores.filter((score) => score === null).length
      }
      readyCoverageIndexed = indexed
      readyCoverageMissing = missing
    } catch {
      console.warn("[P7H CAPACITY] settlement ready coverage unavailable")
    }
  }
  let readyHeadTruncated: boolean | null = null
  let readyCoverageOutsideHead: number | null = null
  const readySample = freshDispatchIds.slice(0, 200)
  let readySetSize: number | null = null
  let readyIndexed: number | null = null
  let readyMissing: number | null = null
  try {
    const indexedSetSize = await redis.zcard("flashpay:settlement:ready:v1")
    if (typeof indexedSetSize !== "number" || !Number.isSafeInteger(indexedSetSize) || indexedSetSize < 0) throw new Error("Invalid settlement ready set size")
    readySetSize = indexedSetSize
    if (readySample.length === 0) {
      readyIndexed = 0
      readyMissing = 0
    } else {
      const readyScores = await redis.zmscore("flashpay:settlement:ready:v1", readySample)
      if (!Array.isArray(readyScores) || readyScores.length !== readySample.length || readyScores.some((score) => score !== null && (typeof score !== "number" || !Number.isFinite(score) || score < 0))) throw new Error("Invalid settlement ready scores")
      readyIndexed = readyScores.filter((score) => score !== null).length
      readyMissing = readyScores.filter((score) => score === null).length
    }
  } catch {
    console.warn("[P7H CAPACITY] settlement ready telemetry unavailable")
  }
  let readyOrderedCount: number | null = null
  let readyFirstScore: number | null = null
  let readyLastScore: number | null = null
  let readyStrictlyIncreasing: boolean | null = null
  let readyOrderedValid = false
  const readyOrderedIds: string[] = []
  let readyRotationStart: string | null = null
  let readyRotationNext: string | null = null
  let readyRotationCas: number | null = null
  let readyRotationCycleMax: number | null = null
  let readyRotationCycleGeneration: number | null = null
  try {
    const storedRotation = await redis.get<unknown>("flashpay:settlement:ready:v1:authority-cursor")
    if (storedRotation !== null && typeof storedRotation !== "string") throw new Error("Invalid settlement ready authority cursor")
    const rotationStart = storedRotation ?? "r:0"
    if (!/^r:[0-9]+$/.test(rotationStart)) throw new Error("Invalid settlement ready authority cursor")
    const rotationScore = Number(rotationStart.slice(2))
    if (!Number.isSafeInteger(rotationScore) || rotationScore < 0 || rotationScore >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid settlement ready authority cursor")
    const cycleStateResult = await redis.eval<[string], string>("local max=redis.call('GET',KEYS[1]); local generation=redis.call('GET',KEYS[2]); if max then local value=tonumber(max); if not value or value < 0 or value >= 9007199254740990 or value ~= math.floor(value) then return '-1' end; if generation then local gen=tonumber(generation); if not gen or gen < 0 or gen >= 9007199254740990 or gen ~= math.floor(gen) then return '-1' end else redis.call('SET',KEYS[2],'1'); generation='1' end; return max..':'..generation end; if ARGV[1] ~= 'r:0' then return '-1' end; local gen=0; if generation then gen=tonumber(generation); if not gen or gen < 0 or gen >= 9007199254740990 or gen ~= math.floor(gen) then return '-1' end end; if gen >= 9007199254740989 then return '-1' end; gen=gen+1; local top=redis.call('ZRANGE',KEYS[3],-1,-1,'WITHSCORES'); if #top ~= 0 and #top ~= 2 then return '-1' end; local base=0; if #top == 2 then local score=tonumber(top[2]); if not score or score < 0 or score >= 9007199254740990 or score ~= math.floor(score) then return '-1' end; base=score end; if base > 9007199254740990 then return '-1' end; redis.call('SET',KEYS[2],gen); redis.call('SET',KEYS[1],base); return tostring(base)..':'..tostring(gen)", ["flashpay:settlement:ready:v1:authority-cycle-max", "flashpay:settlement:ready:v1:authority-cycle-generation", "flashpay:settlement:ready:v1"], [rotationStart])
    const cycleParts = cycleStateResult.split(":")
    if (cycleParts.length !== 2 || !/^[0-9]+$/.test(cycleParts[0]) || !/^[0-9]+$/.test(cycleParts[1])) throw new Error("Invalid settlement ready authority cycle state")
    const cycleMax = Number(cycleParts[0])
    const cycleGeneration = Number(cycleParts[1])
    if (!Number.isSafeInteger(cycleMax) || cycleMax < 0 || cycleMax >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(cycleGeneration) || cycleGeneration < 0 || cycleGeneration >= Number.MAX_SAFE_INTEGER || (rotationScore !== 0 && cycleMax < rotationScore)) throw new Error("Invalid settlement ready authority cycle state")
    readyRotationCycleMax = cycleMax
    readyRotationCycleGeneration = cycleGeneration
    const orderedIds: string[] = []
    let firstScore: number | null = null
    let strictlyIncreasing = true
    let previousScore: number | null = null
    let pageStartScore = rotationScore === 0 ? 0 : rotationScore + 1
    let headTruncated = false
    let rotationEnded = false
    for (let page = 0; page < 4; page += 1) {
      const readyOrdered = await redis.zrange("flashpay:settlement:ready:v1", pageStartScore, cycleMax, { byScore: true, withScores: true, offset: 0, count: 201 })
      if (!Array.isArray(readyOrdered) || readyOrdered.length > 402 || readyOrdered.length % 2 !== 0) throw new Error("Invalid ordered settlement ready telemetry")
      const pairCount = readyOrdered.length / 2
      if (page === 3 && pairCount === 201) headTruncated = true
      for (let index = 0; index < readyOrdered.length; index += 2) {
        const member = readyOrdered[index]
        const score = readyOrdered[index + 1]
        if (typeof member !== "string" || member.length === 0 || member !== member.trim() || typeof score !== "number" || !Number.isSafeInteger(score) || score < 1 || score < pageStartScore) throw new Error("Invalid ordered settlement ready telemetry")
        if (previousScore !== null && score <= previousScore) throw new Error("Invalid ordered settlement ready telemetry")
        if (index / 2 < 200) {
          orderedIds.push(member)
          if (firstScore === null) firstScore = score
          previousScore = score
        } else if (pairCount < 201 || previousScore === null || score <= previousScore) {
          throw new Error("Invalid ordered settlement ready telemetry")
        }
      }
      rotationEnded = pairCount <= 200
      if (rotationEnded) break
      if (previousScore === null || previousScore >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid ordered settlement ready telemetry")
      pageStartScore = previousScore + 1
    }
    if (orderedIds.length > 800) throw new Error("Invalid ordered settlement ready telemetry")
    readyOrderedIds.push(...orderedIds)
    readyOrderedCount = orderedIds.length
    readyFirstScore = firstScore
    readyLastScore = previousScore
    readyStrictlyIncreasing = strictlyIncreasing
    readyHeadTruncated = headTruncated
    readyRotationStart = rotationStart
    readyRotationNext = rotationEnded ? "r:0" : `r:${previousScore}`
    readyOrderedValid = true
  } catch {
    console.warn("[P7H CAPACITY] ordered settlement ready telemetry unavailable")
  }

  if (readyOrderedValid === true && readyCoverageTruncated === false && readyCoverageMissing === 0) {
    const readyHeadIds = new Set(readyOrderedIds)
    readyCoverageOutsideHead = readyCoverageAllIds.filter((id) => !readyHeadIds.has(id)).length
  }

  let readyClassInvalid: number | null = null
  let readyClassPostHorizon: number | null = null
  let readyClassPrepared: number | null = null
  let readyClassRetryable: number | null = null
  let readyClassFresh: number | null = null
  let readyClassStage1Only: number | null = null
  let readyClassReconciling: number | null = null
  let readyClassTerminalEgress: number | null = null
  let readyTerminalEgressIds: string[] = []
  let readyClassReadyOnlyEgress: number | null = null
  let readyReadyOnlyEgressIds: string[] = []
  let readyClassOther: number | null = null
  let readyOtherDiagnosticPatterns: Record<string, number> | null = null
  let readyOtherFreshMissingPatterns: Record<string, number> | null = null
  let readyLegacyQuarantineIds: string[] = []
  let readyShadowEligibleIds: string[] | null = null
  let readyShadowPostHorizonIds: string[] | null = null
  let readyShadowPreparedIds: string[] | null = null
  let readyShadowRetryableIds: string[] | null = null
  let readyShadowFreshIds: string[] | null = null
  let readyShadowFreshCreateIds: string[] | null = null
  let readyShadowStage1OnlyIds: string[] | null = null
  let readyShadowReconcilingIds: string[] | null = null
  let walletDrainShadowCount: number | null = null
  let walletDrainShadowHeadPaymentId: string | null = null
  let walletDrainShadowHeadRefundId: string | null = null
  let walletDrainShadowHeadKind: "settlement" | "refund" | null = null
  let walletDrainSelectedHeadKind: "settlement" | "refund" | null = null
  let walletDrainSelectedHeadPaymentId: string | null = null
  let walletDrainSelectedHeadRefundId: string | null = null
  let walletDrainSelectedHeadParity: boolean | null = null
  let walletDrainNonEmptyParity: boolean | null = null
  let walletDrainNonMoneyCertification = false
  let walletDrainPreExecutionHeadKind: "settlement" | "refund" | null = null
  let walletDrainPreExecutionHeadPaymentId: string | null = null
  let walletDrainPreExecutionHeadRefundId: string | null = null
  let readyEligibleSetParity: boolean | null = null
  let readyFreshSetParity: boolean | null = null
  let readyReconcilingSetParity: boolean | null = null
  try {
    let classInvalid = 0
    const shadowPostHorizonIds: string[] = []
    const shadowPreparedIds: string[] = []
    const shadowRetryableIds: string[] = []
    const shadowFreshDispatchIds: string[] = []
    const shadowFreshCreateIds: string[] = []
    const shadowStage1OnlyIds: string[] = []
    const shadowReconcilingIds: string[] = []
    let classPostHorizon = 0
    let classPrepared = 0
    let classRetryable = 0
    let classFresh = 0
    let classStage1Only = 0
    let classReconciling = 0
    let classTerminalEgress = 0
    const terminalEgressIds: string[] = []
    let classReadyOnlyEgress = 0
    const readyOnlyEgressIds: string[] = []
    let classOther = 0
    const otherDiagnosticPatterns: Record<string, number> = {}
    const otherFreshMissingPatterns: Record<string, number> = {}
    const legacyQuarantineIds: string[] = []
    if (!readyOrderedValid) {
      throw new Error("Ordered settlement ready telemetry unavailable")
    }
    if (readyOrderedIds.length > 0) {
      for (let batchStart = 0; batchStart < readyOrderedIds.length; batchStart += 200) {
        const batchIds = readyOrderedIds.slice(batchStart, batchStart + 200)
        const readyValues = await redis.mget<unknown[]>(batchIds.map((id) => `payment:${id}`))
        if (!Array.isArray(readyValues) || readyValues.length !== batchIds.length) throw new Error("Invalid ordered settlement ready payment telemetry")
        for (let index = 0; index < batchIds.length; index += 1) {
          const payment = parsePayment(readyValues[index])
          const paymentId = batchIds[index]
          if (!payment || payment.id !== paymentId) {
            classInvalid++
          } else if (isReadyIndexTerminalEgressCandidate(payment)) {
            classTerminalEgress++
            terminalEgressIds.push(paymentId)
          } else if (isReadyIndexReadyOnlyEgressCandidate(payment)) {
            classReadyOnlyEgress++
            readyOnlyEgressIds.push(paymentId)
          } else if (isPostHorizonEligible(payment, now)) {
          classPostHorizon++
          shadowPostHorizonIds.push(paymentId)
        } else if (isPreparedSubmitEligible(payment)) {
          classPrepared++
          shadowPreparedIds.push(paymentId)
        } else if (isEligible(payment, now)) {
          classRetryable++
          shadowRetryableIds.push(paymentId)
        } else if (isFreshSettlementDispatchCandidate(payment, now)) {
          classFresh++
          shadowFreshDispatchIds.push(paymentId)
          shadowFreshCreateIds.push(paymentId)
        } else if (isStage1OnlySettlementDispatchCandidate(payment, now)) {
          classStage1Only++
          shadowFreshDispatchIds.push(paymentId)
          shadowStage1OnlyIds.push(paymentId)
        } else if (isStaleFreshReconcilingCandidate(payment, now) || isStaleRetryReconcilingCandidate(payment, now)) {
          classReconciling++
          shadowReconcilingIds.push(paymentId)
        } else {
          classOther++
          const fingerprint = readyOtherDiagnosticFingerprint(payment)
          if (otherDiagnosticPatterns[fingerprint] !== undefined) {
            otherDiagnosticPatterns[fingerprint] += 1
          } else if (Object.keys(otherDiagnosticPatterns).length < 32) {
            otherDiagnosticPatterns[fingerprint] = 1
          } else {
            otherDiagnosticPatterns.overflow = (otherDiagnosticPatterns.overflow ?? 0) + 1
          }
          const freshMissing = readyOtherFreshPrerequisiteFingerprint(payment, now)
          if ((isLegacyReadyUnrepairedCandidate(payment, now) || isLegacyReadyPreviouslyRepairedCandidate(payment, now)) && legacyQuarantineIds.length < LEGACY_READY_QUARANTINE_LIMIT) legacyQuarantineIds.push(paymentId)
          if (otherFreshMissingPatterns[freshMissing] !== undefined) otherFreshMissingPatterns[freshMissing] += 1
          else if (Object.keys(otherFreshMissingPatterns).length < 16) otherFreshMissingPatterns[freshMissing] = 1
          else otherFreshMissingPatterns.overflow = (otherFreshMissingPatterns.overflow ?? 0) + 1
        }
      }
    }
    }
    if (readyHeadTruncated === false && readyCoverageTruncated === false && readyCoverageMissing === 0 && readyCoverageOutsideHead === 0 && classInvalid === 0) {
      const eligibleSet = new Set([...postHorizonIds, ...preparedSubmitIds, ...retryableIds])
      const shadowEligibleSet = new Set([...shadowPostHorizonIds, ...shadowPreparedIds, ...shadowRetryableIds])
      readyEligibleSetParity = eligibleSet.size === shadowEligibleSet.size && [...eligibleSet].every((id) => shadowEligibleSet.has(id))
      const freshSet = new Set(freshDispatchIds)
      const shadowFreshSet = new Set(shadowFreshDispatchIds)
      readyFreshSetParity = freshSet.size === shadowFreshSet.size && [...freshSet].every((id) => shadowFreshSet.has(id))
      const reconcilingSet = new Set([...settlementReconcilingDiscoveryIds, ...staleRetryReconcilingDiscoveryIds])
      const shadowReconcilingSet = new Set(shadowReconcilingIds)
      readyReconcilingSetParity = reconcilingSet.size === shadowReconcilingSet.size && [...reconcilingSet].every((id) => shadowReconcilingSet.has(id))
    }
    readyClassInvalid = classInvalid
    readyClassPostHorizon = classPostHorizon
    readyClassPrepared = classPrepared
    readyClassRetryable = classRetryable
    readyClassFresh = classFresh
    readyClassStage1Only = classStage1Only
    readyClassReconciling = classReconciling
    readyClassOther = classOther
    readyOtherDiagnosticPatterns = otherDiagnosticPatterns
    readyOtherFreshMissingPatterns = otherFreshMissingPatterns
    readyLegacyQuarantineIds = legacyQuarantineIds
    readyTerminalEgressIds = terminalEgressIds
    readyClassTerminalEgress = classTerminalEgress
    readyReadyOnlyEgressIds = readyOnlyEgressIds
    readyClassReadyOnlyEgress = classReadyOnlyEgress
    readyShadowEligibleIds = classInvalid === 0 ? [...shadowPostHorizonIds, ...shadowPreparedIds, ...shadowRetryableIds] : null
    readyShadowPostHorizonIds = classInvalid === 0 ? shadowPostHorizonIds.slice(0, MAX_ATTEMPTS) : null
    readyShadowPreparedIds = classInvalid === 0 ? shadowPreparedIds : null
    readyShadowRetryableIds = classInvalid === 0 ? shadowRetryableIds : null
    readyShadowFreshIds = shadowFreshDispatchIds
    const readyFreshWindow = new Set(readyShadowFreshIds)
    readyShadowFreshCreateIds = classInvalid === 0 ? shadowFreshCreateIds.filter((id) => readyFreshWindow.has(id)) : null
    readyShadowStage1OnlyIds = classInvalid === 0 ? shadowStage1OnlyIds.filter((id) => readyFreshWindow.has(id)) : null
    readyShadowReconcilingIds = shadowReconcilingIds.slice(0, 1)
    if (classInvalid === 0) walletDrainShadowCount = classPrepared + classRetryable + classFresh + classStage1Only + classReconciling
  } catch {
    console.warn("[P7H CAPACITY] ordered settlement ready classification unavailable")
  }

  if (readyOrderedValid === true && readyClassInvalid === 0 && readyShadowEligibleIds !== null && readyShadowPostHorizonIds !== null && readyShadowRetryableIds !== null && readyShadowFreshIds !== null && readyShadowFreshCreateIds !== null && readyShadowStage1OnlyIds !== null && readyShadowReconcilingIds !== null && readyRotationStart !== null && readyRotationNext !== null && readyRotationCycleMax !== null && readyRotationCycleGeneration !== null) {
    try {
      const rotationCas = await redis.eval<[string, string, string, string], number>("local current=redis.call('GET',KEYS[1]); if not current then current='r:0' end; local cycle=redis.call('GET',KEYS[2]); local generation=redis.call('GET',KEYS[3]); if current==ARGV[1] and cycle==ARGV[3] and generation==ARGV[4] then if ARGV[2]=='r:0' then redis.call('SET',KEYS[1],ARGV[2]); redis.call('DEL',KEYS[2]); return 1 end; return redis.call('SET',KEYS[1],ARGV[2]) and 1 or 0 end; return 0", ["flashpay:settlement:ready:v1:authority-cursor", "flashpay:settlement:ready:v1:authority-cycle-max", "flashpay:settlement:ready:v1:authority-cycle-generation"], [readyRotationStart, readyRotationNext, String(readyRotationCycleMax), String(readyRotationCycleGeneration)])
      if (rotationCas !== 0 && rotationCas !== 1) throw new Error("Invalid settlement ready authority cursor CAS")
      readyRotationCas = rotationCas
    } catch {
      console.warn("[P7H CAPACITY] settlement ready authority cursor unavailable")
    }
  }

  let readyResidencyBackfilled: number | null = null
  if (readyResidencySourceValid === true) {
    try {
      let missing = 0
      const missingIds: string[] = []
      for (let batchStart = 0; batchStart < readyResidencyIds.length; batchStart += 200) {
        const batch = readyResidencyIds.slice(batchStart, batchStart + 200)
        const scores = await redis.zmscore("flashpay:settlement:ready:v1", batch)
        if (!Array.isArray(scores) || scores.length !== batch.length || scores.some((score) => score !== null && (typeof score !== "number" || !Number.isSafeInteger(score) || score < 1))) throw new Error("Invalid settlement ready residency telemetry")
        scores.forEach((score, index) => { if (score === null) missingIds.push(batch[index]) })
        missing += scores.filter((score) => score === null).length
      }
      readyResidencyCount = readyResidencyIds.length
      readyResidencyMissing = missing
      if (missingIds.length === 0) {
        readyResidencyBackfilled = 0
      } else {
        const backfilled = await redis.eval<string[], number>("local top=redis.call('ZRANGE',KEYS[1],-1,-1,'WITHSCORES'); if #top ~= 0 and #top ~= 2 then return -1 end; local topScore=0; if #top == 2 then topScore=tonumber(top[2]); if not topScore or topScore < 1 or topScore > 9007199254740990 or topScore ~= math.floor(topScore) then return -1 end end; local seq=redis.call('GET',KEYS[2]); local base=topScore; if seq then base=tonumber(seq); if not base or base < 0 or base > 9007199254740990 or base ~= math.floor(base) or base < topScore then return -1 end end; if base + #ARGV > 9007199254740990 then return -1 end; if not seq then redis.call('SET',KEYS[2],base) end; local added=0; for _,id in ipairs(ARGV) do if redis.call('SISMEMBER',KEYS[3],id)==1 and not redis.call('ZSCORE',KEYS[1],id) then local next=redis.call('INCR',KEYS[2]); redis.call('ZADD',KEYS[1],'NX',next,id); added=added+1 end end; return added", ["flashpay:settlement:ready:v1", "flashpay:settlement:ready:v1:sequence", "flashpay:recovery:active-payments:v1"], missingIds)
        if (!Number.isSafeInteger(backfilled) || backfilled < 0 || backfilled > missingIds.length) throw new Error("Invalid settlement ready residency backfill")
        readyResidencyBackfilled = backfilled
      }
    } catch {
      console.warn("[P7H CAPACITY] settlement ready residency telemetry unavailable")
    }
  }


  if (!readyBaselineCoverageCertified && readyResidencySourceValid === true && readyResidencyMissing !== null && readyResidencyBackfilled !== null && readyResidencyBackfilled === readyResidencyMissing) {
    try {
      const observedActiveIds = keys.map((key) => key.slice("payment:".length))
      for (let batchStart = 0; batchStart < observedActiveIds.length; batchStart += 200) {
        const batch = observedActiveIds.slice(batchStart, batchStart + 200)
        if (batch.length > 0) await redis.eval<string[], number>("for _,id in ipairs(ARGV) do redis.call('SADD',KEYS[1],id) end; return #ARGV", [READY_BASELINE_SCAN_SEEN_KEY], batch)
      }
    } catch {
      readyResidencySourceValid = false
    }
  }

  let readyLegacyQuarantineAttempted = 0
  let readyLegacyQuarantineSucceeded = 0
  for (const paymentId of readyLegacyQuarantineIds) {
    readyLegacyQuarantineAttempted += 1
    try { if (await quarantineLegacyReadyCandidate(paymentId)) readyLegacyQuarantineSucceeded += 1 } catch { /* fail closed; leave canonical state unchanged */ }
  }

  const discoveryDurationMs = Date.now() - discoveryStartedAt

  let readyAuthorityCertified = readyBaselineCoverageCertified
  if (!readyBaselineCoverageCertified && readyResidencySourceValid === true && scanNextToken === "c:0" && Number.isSafeInteger(activeSetSize) && activeSetSize >= 0 && readyResidencyMissing !== null && readyResidencyBackfilled !== null && readyResidencyBackfilled === readyResidencyMissing) {
    try {
      const exactBaselineCoverage = await redis.eval<[], number>("local missing=redis.call('SDIFFSTORE',KEYS[3],KEYS[1],KEYS[2]); local stale=redis.call('SDIFFSTORE',KEYS[4],KEYS[2],KEYS[1]); redis.call('DEL',KEYS[3]); redis.call('DEL',KEYS[4]); if missing==0 and stale==0 then redis.call('SET',KEYS[5],'done'); return 1 end; return 0", ["flashpay:recovery:active-payments:v1", READY_BASELINE_SCAN_SEEN_KEY, `${READY_BASELINE_SCAN_SEEN_KEY}:missing`, `${READY_BASELINE_SCAN_SEEN_KEY}:stale`, READY_BASELINE_COVERAGE_KEY], [])
      if (exactBaselineCoverage !== 0 && exactBaselineCoverage !== 1) throw new Error("Invalid settlement ready baseline coverage")
      readyAuthorityCertified = exactBaselineCoverage === 1
      if (readyAuthorityCertified) {
        readyBaselineCoverageCertified = true
        try { await redis.del(READY_BASELINE_SCAN_SEEN_KEY) } catch { console.warn("[P7H CAPACITY] settlement ready baseline scan cleanup unavailable") }
      }
    } catch {
      console.warn("[P7H CAPACITY] settlement ready baseline coverage unavailable")
    }
  }
  const readySchedulerUsable = readyAuthorityCertified && readyRotationStart === "r:0" && readyStrictlyIncreasing === true && readyClassInvalid === 0 && readyEligibleSetParity === true && readyFreshSetParity === true && readyReconcilingSetParity === true && readyShadowEligibleIds !== null && readyShadowPostHorizonIds !== null && readyShadowRetryableIds !== null && readyShadowFreshIds !== null && readyShadowFreshCreateIds !== null && readyShadowStage1OnlyIds !== null && readyShadowReconcilingIds !== null
  let readyBaselineCertified: boolean | null = null
  try {
    const baselineResult = await redis.eval<[string], number>("local current=redis.call('GET',KEYS[1]); if current=='done' then return 1 end; if current then return -1 end; if ARGV[1]=='1' then redis.call('SET',KEYS[1],'done'); return 1 end; return 0", ["flashpay:settlement:ready:v1:authority-baseline"], [readySchedulerUsable ? "1" : "0"])
    if (baselineResult !== -1 && baselineResult !== 0 && baselineResult !== 1) throw new Error("Invalid settlement ready authority baseline")
    if (baselineResult === -1) {
      console.warn("[P7H CAPACITY] settlement ready authority baseline mismatch")
    } else {
      readyBaselineCertified = baselineResult === 1
      if (!readyBaselineAlreadyCertified && readyBaselineCertified) {
        try { await redis.del(READY_BASELINE_SCAN_SEEN_KEY); await redis.del(READY_BASELINE_COVERAGE_KEY) } catch { console.warn("[P7H CAPACITY] settlement ready baseline cleanup unavailable") }
      }
    }
  } catch {
    console.warn("[P7H CAPACITY] settlement ready authority baseline unavailable")
  }
  const readyWindowCertified = readyBaselineCertified === true && readyRotationCas === 1 && readyOrderedValid === true && readyStrictlyIncreasing === true && readyClassInvalid === 0 && readyResidencySourceValid === true && readyResidencyMissing === 0 && readyResidencyBackfilled === 0 && readyShadowEligibleIds !== null && readyShadowPostHorizonIds !== null && readyShadowRetryableIds !== null && readyShadowFreshIds !== null && readyShadowFreshCreateIds !== null && readyShadowStage1OnlyIds !== null && readyShadowReconcilingIds !== null
  const useReadyExecution = readyWindowCertified === true
  const eligibleIds = readyShadowEligibleIds !== null && useReadyExecution ? readyShadowEligibleIds : [...postHorizonIds, ...preparedSubmitIds, ...retryableIds].slice(0, MAX_ATTEMPTS)
  const freshExecutionIds = readyShadowFreshIds !== null && useReadyExecution ? readyShadowFreshIds : freshDispatchIds.slice(0, MAX_ATTEMPTS)
  const settlementReconcilingExecutionIds = readyShadowReconcilingIds !== null && useReadyExecution ? readyShadowReconcilingIds : [...new Set([...settlementReconcilingDiscoveryIds, ...staleRetryReconcilingDiscoveryIds])].slice(0, 1)
  const retryableIdSet = new Set(retryableIds)
  const walletDrainFairnessClass = useReadyExecution ? walletDrainFairnessClassForGeneration(readyRotationCycleGeneration) : null
  const walletFreshExecutionIds = useReadyExecution && readyShadowRetryableIds !== null && readyShadowFreshIds !== null && readyShadowFreshCreateIds !== null && readyShadowStage1OnlyIds !== null
    ? immediateDrainMode
      ? (piCreateBackpressureActive() ? readyShadowStage1OnlyIds : [...readyShadowRetryableIds, ...readyShadowFreshIds])
      : readyShadowStage1OnlyIds
    : []

  const selectWalletDrainHead = (preparedIds: string[], eligibleIds: string[], freshIds: string[], reconcilingIds: string[], refundPaymentId: string | null, refundId: string | null, fairnessClass: WalletDrainFairnessClass | null): { kind: "settlement" | "refund" | null; paymentId: string | null; refundId: string | null; lane: WalletDrainLane | null } => {
    const preparedHead = eligibleIds.find((id) => preparedIds.includes(id))
    if (preparedHead !== undefined) return { kind: "settlement", paymentId: preparedHead, refundId: null, lane: "prepared" }
    if (fairnessClass === null) return { kind: null, paymentId: null, refundId: null, lane: null }

    const candidates: Record<WalletDrainFairnessClass, { kind: "settlement" | "refund"; paymentId: string; refundId: string | null } | null> = {
      fresh: freshIds[0] !== undefined ? { kind: "settlement", paymentId: freshIds[0], refundId: null } : null,
      reconciling: reconcilingIds[0] !== undefined ? { kind: "settlement", paymentId: reconcilingIds[0], refundId: null } : null,
      refund: refundPaymentId !== null && refundId !== null ? { kind: "refund", paymentId: refundPaymentId, refundId } : null,
    }
    const startIndex = WALLET_DRAIN_FAIRNESS_ORDER.indexOf(fairnessClass)
    for (let offset = 0; offset < WALLET_DRAIN_FAIRNESS_ORDER.length; offset += 1) {
      const lane = WALLET_DRAIN_FAIRNESS_ORDER[(startIndex + offset) % WALLET_DRAIN_FAIRNESS_ORDER.length]
      const candidate = candidates[lane]
      if (candidate !== null) return { ...candidate, lane }
    }
    return { kind: null, paymentId: null, refundId: null, lane: null }
  }

  let refundAccountingReady: boolean | null = null
  const refundResults: Array<Awaited<ReturnType<typeof ensureAutomaticRefundIntent>>> = []
  let refundIntakePeakInFlight = 0

  // Prepare newly eligible automatic refunds before wallet-head selection. These steps may
  // create/recover the Pi refund payment identifier, but are hard-gated from blockchain
  // submission. The existing wallet scheduler remains the sole authority for money movement.
  if (refundCandidateIds.length > 0) {
    refundAccountingReady = (await query("SELECT 1 FROM refund_accounting_records LIMIT 0")) !== null
    if (refundAccountingReady) {
      for (const paymentId of refundCandidateIds.slice(0, MAX_ATTEMPTS)) {
        let intake: Awaited<ReturnType<typeof ensureAutomaticRefundIntent>>
        try {
          intake = await ensureAutomaticRefundIntent(paymentId)
        } catch {
          intake = { outcome: "blocked", paymentId, reason: "intake_exception" }
        }
        refundResults.push(intake)
        refundIntakePeakInFlight = 1
        if (intake.outcome === "blocked" || typeof intake.refundId !== "string") continue

        for (let prepareStep = 0; prepareStep < 3; prepareStep += 1) {
          const prepared = await runAutomaticRefundPreparationStep(paymentId, intake.refundId)
          if (prepared.state !== "ok" || prepared.result.outcome !== "success") break
        }

        // A prior wake may already have blockchain-confirmed this refund. If so, complete
        // only its non-wallet checkpoints now; this helper refuses all pre-confirmation stages.
        for (let finalizeStep = 0; finalizeStep < 5; finalizeStep += 1) {
          const latestRefundPayment = parsePayment(await redis.get(`payment:${paymentId}`))
          if (latestRefundPayment?.id === paymentId && latestRefundPayment.status === "refunded" && latestRefundPayment.refundStatus === "completed" && latestRefundPayment.settlementFailureState === "refunded") break
          const finalized = await runAutomaticRefundFinalizationStep(paymentId, intake.refundId)
          if (finalized.state !== "ok" || finalized.result.outcome !== "success") break
        }
      }
    }
  }

  const preRefundDrain = await readAutomaticRefundDrainHead(MAX_ATTEMPTS)
  if (preRefundDrain.state === "ok") {
    const preTelemetryHead = selectWalletDrainHead(useReadyExecution && readyShadowPreparedIds !== null ? readyShadowPreparedIds : preparedSubmitIds, eligibleIds, walletFreshExecutionIds, settlementReconcilingExecutionIds, preRefundDrain.refundDrainHeadPaymentId, preRefundDrain.refundDrainHeadRefundId, walletDrainFairnessClass)
    walletDrainPreExecutionHeadKind = preTelemetryHead.kind
    walletDrainPreExecutionHeadPaymentId = preTelemetryHead.paymentId
    walletDrainPreExecutionHeadRefundId = preTelemetryHead.refundId
  }

  let preHead: ReturnType<typeof selectWalletDrainHead> | null = null
  if (useReadyExecution && readyShadowPreparedIds !== null && preRefundDrain.state === "ok") {
    preHead = selectWalletDrainHead(readyShadowPreparedIds, eligibleIds, walletFreshExecutionIds, settlementReconcilingExecutionIds, preRefundDrain.refundDrainHeadPaymentId, preRefundDrain.refundDrainHeadRefundId, walletDrainFairnessClass)
  }
  console.log("[transient-wake] scheduler wallet authority", { ready: preHead !== null, schedulerWalletPaymentId: preHead?.kind === "settlement" ? preHead.paymentId : null, refundPaymentId: preHead?.kind === "refund" ? preHead.paymentId : null, refundId: preHead?.kind === "refund" ? preHead.refundId : null })

  if (!await drainLease.renew()) return NextResponse.json({ error: "Transient drain lease ownership lost" }, { status: 503 })
  console.log("[P7J5 LEASE] renewed before work")

  const workStartedAt = Date.now()
  const results: Array<{ paymentId: string; ok: boolean; status?: string; error?: string }> = []
  const preparedExecutionIds = useReadyExecution && readyShadowPreparedIds !== null ? readyShadowPreparedIds : preparedSubmitIds
  const preparedExecutionSet = new Set(useReadyExecution ? preparedExecutionIds : [])

  const nonAuthoritativeEligibleIds = useReadyExecution && readyShadowPostHorizonIds !== null
    ? readyShadowPostHorizonIds
    : eligibleIds.filter((paymentId) => !preparedExecutionSet.has(paymentId) && !retryableIdSet.has(paymentId))
  const eligiblePipeline = await runBoundedOrderedPipeline<RecoveryPipelineValue>(nonAuthoritativeEligibleIds, async (paymentId) => {
    const result = await executeA2URecovery(paymentId, null)
    const latest = parsePayment(await redis.get(`payment:${paymentId}`))
    const backpressureTriggered = retryableIdSet.has(paymentId) && latest !== null ? await registerPiCreateBackpressure(latest) : false
    return {
      value: { paymentId, ok: result.status === "success" || result.status === "db_reconciled", status: latest?.status, error: result.details?.error },
      stop: backpressureTriggered,
    }
  })
  results.push(...eligiblePipeline.values)

  const walletDrainAttemptedSettlementIds = new Set<string>()
  const walletDrainAttemptedRefundIds = new Set<string>()
  const walletDrainBurstLanes: WalletDrainLane[] = []
  let walletDrainBurstSettlementAttempts = 0
  let walletDrainBurstRefundAttempts = 0
  let walletDrainBurstStopReason: string | null = null
  let walletDrainFairnessOffset = 0
  let walletDrainBudgetExhausted = false
  let walletDrainDeferredDbCount = 0
  let currentRefundDrain = preRefundDrain
  const walletDrainBurstStartedAt = Date.now()

  if (useReadyExecution && readyShadowPreparedIds !== null && readyShadowFreshIds !== null && readyShadowStage1OnlyIds !== null && walletDrainFairnessClass !== null && currentRefundDrain.state === "ok") {
    const fairnessStartIndex = WALLET_DRAIN_FAIRNESS_ORDER.indexOf(walletDrainFairnessClass)
    while (true) {
      if (Date.now() - walletDrainBurstStartedAt >= WALLET_DRAIN_BURST_BUDGET_MS) {
        walletDrainBudgetExhausted = true
        break
      }
      if (!await drainLease.renew()) return NextResponse.json({ error: "Transient drain lease ownership lost" }, { status: 503 })
      if (currentRefundDrain.state !== "ok") break

      const attemptFairnessClass = WALLET_DRAIN_FAIRNESS_ORDER[(fairnessStartIndex + walletDrainFairnessOffset) % WALLET_DRAIN_FAIRNESS_ORDER.length]
      const attemptFreshIds = (piCreateBackpressureActive() && readyShadowStage1OnlyIds !== null ? readyShadowStage1OnlyIds : readyShadowFreshIds).filter((id) => !walletDrainAttemptedSettlementIds.has(id))
      const attemptHead = selectWalletDrainHead(
        readyShadowPreparedIds.filter((id) => !walletDrainAttemptedSettlementIds.has(id)),
        eligibleIds.filter((id) => !walletDrainAttemptedSettlementIds.has(id)),
        attemptFreshIds,
        settlementReconcilingExecutionIds.filter((id) => !walletDrainAttemptedSettlementIds.has(id)),
        currentRefundDrain.refundDrainHeadPaymentId !== null && currentRefundDrain.refundDrainHeadRefundId !== null && !walletDrainAttemptedRefundIds.has(currentRefundDrain.refundDrainHeadRefundId) ? currentRefundDrain.refundDrainHeadPaymentId : null,
        currentRefundDrain.refundDrainHeadPaymentId !== null && currentRefundDrain.refundDrainHeadRefundId !== null && !walletDrainAttemptedRefundIds.has(currentRefundDrain.refundDrainHeadRefundId) ? currentRefundDrain.refundDrainHeadRefundId : null,
        attemptFairnessClass,
      )
      if (attemptHead.kind === null || attemptHead.lane === null) break
      walletDrainBurstLanes.push(attemptHead.lane)

      if (attemptHead.kind === "settlement" && attemptHead.paymentId !== null) {
        walletDrainAttemptedSettlementIds.add(attemptHead.paymentId)
        walletDrainBurstSettlementAttempts += 1
        const selectedNeedsPiCreateBackpressureObservation = readyShadowFreshCreateIds?.includes(attemptHead.paymentId) === true || readyShadowRetryableIds?.includes(attemptHead.paymentId) === true
        const result = await executeA2URecovery(attemptHead.paymentId, attemptHead.paymentId)
        const latest = parsePayment(await redis.get(`payment:${attemptHead.paymentId}`))
        if (selectedNeedsPiCreateBackpressureObservation && latest !== null) await registerPiCreateBackpressure(latest)
        const canonicalFinal = latest !== null && isPaymentFinal(latest)
        const piSlotReleasedDbPending = isPiA2USlotReleasedForDbPending(latest) && result.status === "pi_completed_db_pending"
        const value: RecoveryPipelineValue = { paymentId: attemptHead.paymentId, ok: canonicalFinal, status: latest?.status, error: result.details?.error }
        const existingIndex = results.findIndex((item) => item.paymentId === attemptHead.paymentId)
        if (existingIndex >= 0) results[existingIndex] = value
        else results.push(value)
        if (piSlotReleasedDbPending) walletDrainDeferredDbCount += 1
        const settlementSafeToContinue = canonicalFinal || piSlotReleasedDbPending
        if (!settlementSafeToContinue) {
          walletDrainBurstStopReason = `settlement_${result.state}`
          break
        }
      } else if (attemptHead.kind === "refund" && attemptHead.paymentId !== null && attemptHead.refundId !== null) {
        if (refundAccountingReady === null) refundAccountingReady = (await query("SELECT 1 FROM refund_accounting_records LIMIT 0")) !== null
        if (!refundAccountingReady) break
        walletDrainAttemptedRefundIds.add(attemptHead.refundId)
        walletDrainBurstRefundAttempts += 1
        let authorizedRefundPass: Awaited<ReturnType<typeof runAutomaticRefundPass>>
        try {
          authorizedRefundPass = await runAutomaticRefundPass(MAX_ATTEMPTS, { paymentId: attemptHead.paymentId, refundId: attemptHead.refundId })
        } catch {
          authorizedRefundPass = { state: "blocked" }
        }
        if (authorizedRefundPass.state !== "ok") {
          walletDrainBurstStopReason = "refund_pass_blocked"
          break
        }
        const authorizedRefundResult = authorizedRefundPass.results.find((item) => item.refundId === attemptHead.refundId && item.paymentId === attemptHead.paymentId && item.action === "execute")
        if (authorizedRefundResult?.outcome !== "success") {
          walletDrainBurstStopReason = `refund_${authorizedRefundResult?.reason ?? authorizedRefundResult?.outcome ?? "unresolved"}`
          break
        }

        // Once the wallet-authorized refund movement has durably succeeded, finish only this
        // refund's non-wallet checkpoints in the same wake. Every step re-reads the canonical
        // checkpoint and uses the existing executor/accounting guards. Any uncertainty stops
        // immediately and leaves the durable checkpoint for the next external wake.
        for (let finalizeStep = 0; finalizeStep < 5; finalizeStep += 1) {
          const latestRefundPayment = parsePayment(await redis.get(`payment:${attemptHead.paymentId}`))
          if (latestRefundPayment?.id === attemptHead.paymentId && latestRefundPayment.status === "refunded" && latestRefundPayment.refundStatus === "completed" && latestRefundPayment.settlementFailureState === "refunded") break
          if (Date.now() - walletDrainBurstStartedAt >= WALLET_DRAIN_BURST_BUDGET_MS) break
          const targeted = await runAutomaticRefundFinalizationStep(attemptHead.paymentId, attemptHead.refundId)
          if (targeted.state !== "ok" || targeted.result.outcome !== "success") {
            walletDrainBurstStopReason = `refund_finalize_${targeted.state === "ok" ? targeted.result.reason ?? targeted.result.outcome : "blocked"}`
            break
          }
        }
        if (walletDrainBurstStopReason !== null) break
        currentRefundDrain = await readAutomaticRefundDrainHead(MAX_ATTEMPTS)
        if (currentRefundDrain.state !== "ok") {
          walletDrainBurstStopReason = "refund_head_unavailable"
          break
        }
      }

      if (attemptHead.lane !== "prepared") {
        const selectedFairnessIndex = WALLET_DRAIN_FAIRNESS_ORDER.indexOf(attemptHead.lane)
        walletDrainFairnessOffset = (selectedFairnessIndex - fairnessStartIndex + 1 + WALLET_DRAIN_FAIRNESS_ORDER.length) % WALLET_DRAIN_FAIRNESS_ORDER.length
      }
    }
  }
  const walletDrainBurstDurationMs = Date.now() - walletDrainBurstStartedAt

  const nonAuthoritativeFreshExecutionIds: string[] = []
  const freshPipeline = await runBoundedOrderedPipeline<RecoveryPipelineValue>(nonAuthoritativeFreshExecutionIds, async (id) => {
    const payment = parsePayment(await redis.get(`payment:${id}`))
    if (payment?.id !== id) return {}
    const handlerNow = Date.now()
    const freshCreate = isFreshSettlementDispatchCandidate(payment, handlerNow)
    const stage1Only = isStage1OnlySettlementDispatchCandidate(payment, handlerNow)
    if (!freshCreate && !stage1Only) return {}
    if (freshCreate && piCreateBackpressureActive()) return { value: { paymentId: id, ok: false, status: payment.status, error: "pi_create_backpressure" } }
    const result = await executeA2URecovery(id, null)
    const latest = parsePayment(await redis.get(`payment:${id}`))
    const backpressureTriggered = freshCreate && latest !== null ? await registerPiCreateBackpressure(latest) : false
    return {
      value: { paymentId: id, ok: result.status === "success", status: latest?.status, error: result.details?.error },
      stop: backpressureTriggered,
    }
  })
  results.push(...freshPipeline.values)

  const reconcilingPipeline = await runBoundedOrderedPipeline<RecoveryPipelineValue>(settlementReconcilingExecutionIds.filter((id) => !walletDrainAttemptedSettlementIds.has(id)), async (id) => {
    const payment = parsePayment(await redis.get(`payment:${id}`))
    if (payment?.id !== id || (!isStaleFreshReconcilingCandidate(payment, Date.now()) && !isStaleRetryReconcilingCandidate(payment, Date.now()))) return {}
    const result = await executeA2URecovery(id, null)
    const latest = parsePayment(await redis.get(`payment:${id}`))
    return { value: { paymentId: id, ok: result.status === "success", status: latest?.status, error: result.details?.error } }
  })
  results.push(...reconcilingPipeline.values)
  const settlementPipelinePeakInFlight = Math.max(eligiblePipeline.peakInFlight, freshPipeline.peakInFlight, reconcilingPipeline.peakInFlight)

  if (!await drainLease.renew()) return NextResponse.json({ error: "Transient drain lease ownership lost" }, { status: 503 })
  console.log("[P7J5 LEASE] renewed before refund drain")

  await logF27RefundCheckpointDiagnostic("db04df04-0297-4242-9bbd-cd25cd7c40c6", "5cbfd33b-3eb7-474d-afaa-7f4711919bdd")

  let refundPass: Awaited<ReturnType<typeof runAutomaticRefundPass>>
  if (refundAccountingReady === null) refundAccountingReady = (await query("SELECT 1 FROM refund_accounting_records LIMIT 0")) !== null
  if (refundAccountingReady) {
    try {
      refundPass = await runAutomaticRefundPass(MAX_ATTEMPTS, null)
    } catch {
      refundPass = { state: "blocked" }
    }
  } else {
    refundPass = { state: "blocked" }
  }

  if (walletDrainShadowCount !== null && refundPass.state === "ok" && (!useReadyExecution || readyShadowPreparedIds !== null)) {
    walletDrainShadowCount += refundPass.refundDrainCount
    const preparedIds = useReadyExecution && readyShadowPreparedIds !== null ? readyShadowPreparedIds : preparedSubmitIds
    const shadowHead = selectWalletDrainHead(preparedIds, eligibleIds, walletFreshExecutionIds, settlementReconcilingExecutionIds, refundPass.refundDrainHeadPaymentId, refundPass.refundDrainHeadRefundId, walletDrainFairnessClass)
    walletDrainShadowHeadPaymentId = shadowHead.paymentId
    walletDrainShadowHeadRefundId = shadowHead.refundId
    walletDrainShadowHeadKind = shadowHead.kind
  } else {
    walletDrainShadowCount = null
    walletDrainShadowHeadPaymentId = null
    walletDrainShadowHeadRefundId = null
    walletDrainShadowHeadKind = null
  }

  if (walletDrainShadowCount !== null && refundPass.state === "ok" && (!useReadyExecution || readyShadowPreparedIds !== null)) {
    const preparedIds = useReadyExecution && readyShadowPreparedIds !== null ? readyShadowPreparedIds : preparedSubmitIds
    const selectedHead = selectWalletDrainHead(preparedIds, eligibleIds, walletFreshExecutionIds, settlementReconcilingExecutionIds, refundPass.refundDrainHeadPaymentId, refundPass.refundDrainHeadRefundId, walletDrainFairnessClass)
    walletDrainSelectedHeadKind = selectedHead.kind
    walletDrainSelectedHeadPaymentId = selectedHead.paymentId
    walletDrainSelectedHeadRefundId = selectedHead.refundId
    walletDrainSelectedHeadParity = selectedHead.kind === walletDrainShadowHeadKind && selectedHead.paymentId === walletDrainShadowHeadPaymentId && selectedHead.refundId === walletDrainShadowHeadRefundId
  } else {
    walletDrainSelectedHeadKind = null
    walletDrainSelectedHeadPaymentId = null
    walletDrainSelectedHeadRefundId = null
    walletDrainSelectedHeadParity = null
  }

  const shadowHeadValid = (walletDrainShadowHeadKind === "settlement" && walletDrainShadowHeadPaymentId !== null && walletDrainShadowHeadRefundId === null) || (walletDrainShadowHeadKind === "refund" && walletDrainShadowHeadPaymentId !== null && walletDrainShadowHeadRefundId !== null)
  const selectedHeadValid = (walletDrainSelectedHeadKind === "settlement" && walletDrainSelectedHeadPaymentId !== null && walletDrainSelectedHeadRefundId === null) || (walletDrainSelectedHeadKind === "refund" && walletDrainSelectedHeadPaymentId !== null && walletDrainSelectedHeadRefundId !== null)
  if (walletDrainShadowCount !== null && walletDrainShadowCount > 0 && walletDrainSelectedHeadParity !== null && shadowHeadValid && selectedHeadValid) walletDrainNonEmptyParity = walletDrainSelectedHeadParity
  const certificationA = selectWalletDrainHead(["p"], ["p"], ["f"], ["q"], "rp", "r", "refund")
  const certificationB = selectWalletDrainHead([], [], ["f"], ["q"], "rp", "r", "fresh")
  const certificationC = selectWalletDrainHead([], [], ["f"], ["q"], "rp", "r", "reconciling")
  const certificationD = selectWalletDrainHead([], [], ["f"], ["q"], "rp", "r", "refund")
  const certificationE = selectWalletDrainHead([], [], ["f"], [], null, null, "refund")
  walletDrainNonMoneyCertification = certificationA.lane === "prepared" && certificationA.paymentId === "p" && certificationB.lane === "fresh" && certificationB.paymentId === "f" && certificationC.lane === "reconciling" && certificationC.paymentId === "q" && certificationD.lane === "refund" && certificationD.paymentId === "rp" && certificationD.refundId === "r" && certificationE.lane === "fresh" && certificationE.paymentId === "f"

  const settlementReconcilingEvidence = { FOUND: 0, CONFIRMED_NONE: 0, INDETERMINATE: 0, skipped: 0 }
  const settlementReconcilingEvidenceIds = [...new Set([...settlementReconcilingDiscoveryIds, ...staleRetryReconcilingDiscoveryIds])].slice(0, 1)
  for (const id of settlementReconcilingEvidenceIds) {
    const payment = parsePayment(await redis.get(`payment:${id}`))
    if (!payment || payment.id !== id || (!isStaleFreshReconcilingCandidate(payment, Date.now()) && !isStaleRetryReconcilingCandidate(payment, Date.now()))) {
      settlementReconcilingEvidence.skipped++
      continue
    }
    const customerAmount = payment.customerAmount
    const merchantUid = payment.merchantUid
    if (typeof customerAmount !== "number" || !Number.isFinite(customerAmount) || customerAmount <= 0 || typeof merchantUid !== "string" || merchantUid.trim() === "" || merchantUid !== merchantUid.trim()) {
      settlementReconcilingEvidence.skipped++
      continue
    }
    const evidence = await reconcileIncompleteA2UPayment(id, customerAmount, merchantUid)
    settlementReconcilingEvidence[evidence.outcome]++
  }

  if (!await drainLease.renew()) return NextResponse.json({ error: "Transient drain lease ownership lost" }, { status: 503 })
  console.log("[P7J5 LEASE] renewed before cursor handoff")

  let readyTerminalEgressPrunedCount = 0
  let readyReadyOnlyEgressPrunedCount = 0
  if (readyTerminalEgressIds.length > 0) {
    try {
      const pruned = await redis.eval<string[], number>("local removed=0; for _,id in ipairs(ARGV) do local a=redis.call('SREM',KEYS[1],id); local r=redis.call('ZREM',KEYS[2],id); if a==1 or r==1 then removed=removed+1 end end; return removed", ["flashpay:recovery:active-payments:v1", "flashpay:settlement:ready:v1"], readyTerminalEgressIds)
      if (!Number.isSafeInteger(pruned) || pruned < 0 || pruned > readyTerminalEgressIds.length) throw new Error("Invalid terminal egress prune result")
      readyTerminalEgressPrunedCount = pruned
    } catch (error) {
      console.warn("[P7J12K HYGIENE] terminal ready/active prune unavailable", error)
    }
  }
  if (readyReadyOnlyEgressIds.length > 0) {
    try {
      const pruned = await redis.eval<string[], number>("local removed=0; for _,id in ipairs(ARGV) do removed=removed+redis.call('ZREM',KEYS[1],id) end; return removed", ["flashpay:settlement:ready:v1"], readyReadyOnlyEgressIds)
      if (!Number.isSafeInteger(pruned) || pruned < 0 || pruned > readyReadyOnlyEgressIds.length) throw new Error("Invalid ready-only egress prune result")
      readyReadyOnlyEgressPrunedCount = pruned
    } catch (error) {
      console.warn("[P7J12K HYGIENE] ready-only settlement prune unavailable", error)
    }
  }

  try {
    const cursorCasResult = await redis.eval<[string, string], number>(`local current = redis.call('GET', KEYS[1]) or 'c:0'
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`, ["flashpay:recovery:active-payments:v1:scan-cursor"], [scanStartToken, scanNextToken])
    if (cursorCasResult !== 0 && cursorCasResult !== 1) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
  } catch {
    return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
  }

  let walletDrainContinuationScheduled = false
  let walletDrainKickGateReleased = false
  let walletDrainKickGateReleaseDeferred = false
  const periodicFreshCreateDetected = !immediateDrainMode && useReadyExecution && !piCreateBackpressureActive() && ((readyShadowFreshCreateIds?.length ?? 0) > 0 || (readyShadowRetryableIds?.length ?? 0) > 0)
  const continuationNeeded = useReadyExecution && walletDrainBurstStopReason === null && (readyLegacyQuarantineSucceeded > 0 || periodicFreshCreateDetected || walletDrainDeferredDbCount > 0 || (!piCreateBackpressureActive() && (walletDrainBudgetExhausted || (readyRotationNext !== null && readyRotationNext !== "r:0"))))
  if (continuationNeeded) {
    walletDrainContinuationScheduled = scheduleTrustedTransientRequest("continuation-kick")
  } else if (useReadyExecution && walletDrainBurstStopReason === null && !piCreateBackpressureActive()) {
    try {
      const sequenceValue = await redis.get<unknown>(READY_SEQUENCE_KEY)
      const sequenceText = typeof sequenceValue === "number" && Number.isSafeInteger(sequenceValue) && sequenceValue >= 0 ? String(sequenceValue) : typeof sequenceValue === "string" && /^[0-9]+$/.test(sequenceValue) ? sequenceValue : null
      if (sequenceText !== null) {
        const gateReleaseResult = await redis.eval<[string], number>("local current=redis.call('GET',KEYS[2]); if current ~= ARGV[1] then return 0 end; redis.call('DEL',KEYS[1]); return 1", [IMMEDIATE_DRAIN_KICK_KEY, READY_SEQUENCE_KEY], [sequenceText])
        if (gateReleaseResult === 1) {
          walletDrainKickGateReleased = true
        } else if (gateReleaseResult === 0) {
          walletDrainKickGateReleaseDeferred = true
          walletDrainContinuationScheduled = scheduleTrustedTransientRequest("continuation-kick")
        } else {
          throw new Error("Invalid immediate drain gate release result")
        }
      }
    } catch {
      console.warn("[P7J12D CONTINUATION] immediate drain kick gate cleanup unavailable; TTL safety retained")
    }
  }

  const workDurationMs = Date.now() - workStartedAt
  const wakeDurationMs = Date.now() - wakeStartedAt
  console.log("[P7J12 OTHER PREREQ]", { readyClassOther, readyOtherFreshMissingPatterns, readyLegacyQuarantineAttempted, readyLegacyQuarantineSucceeded })
  console.log("[P7H CAPACITY] transient wake", { discoveryDurationMs, workDurationMs, wakeDurationMs, activeSetSize, keys: keys.length, postHorizonIds: postHorizonIds.length, preparedSubmitIds: preparedSubmitIds.length, retryableIds: retryableIds.length, freshDispatchIds: freshDispatchIds.length, settlementReconcilingDiscoveryIds: settlementReconcilingDiscoveryIds.length, staleRetryReconcilingDiscoveryIds: staleRetryReconcilingDiscoveryIds.length, refundCandidateIds: refundCandidateIds.length, eligibleIds: eligibleIds.length, results: results.length, refundResults: refundResults.length, boundedPipelineConcurrency: BOUNDED_PIPELINE_CONCURRENCY, settlementPipelinePeakInFlight, refundIntakePeakInFlight, piCreateBackpressureActive: piCreateBackpressureActive(), piCreateBackpressureUntilMs, piCreateBackpressureUnavailable, walletDrainFairnessClass, walletDrainFairnessSelectedLane: preHead?.lane ?? null, walletDrainFairnessPreparedOverride: preHead?.lane === "prepared", walletDrainFairnessFreshCreateSuppressed: piCreateBackpressureActive() && (readyShadowFreshCreateIds?.length ?? 0) > 0, walletDrainBurstLimit: WALLET_DRAIN_BURST_LIMIT, walletDrainBurstBudgetMs: WALLET_DRAIN_BURST_BUDGET_MS, walletDrainBurstDurationMs, walletDrainBudgetExhausted, immediateDrainMode, periodicFreshCreateDetected, walletDrainDeferredDbCount, walletDrainBurstSettlementAttempts, walletDrainBurstRefundAttempts, walletDrainBurstStopReason, walletDrainBurstLanes, walletDrainContinuationScheduled, walletDrainKickGateReleased, walletDrainKickGateReleaseDeferred, readySampleSize: readySample.length, readySetSize, readyIndexed, readyMissing, readyOrderedCount, readyFirstScore, readyLastScore, readyStrictlyIncreasing, readyClassInvalid, readyClassPostHorizon, readyClassPrepared, readyClassRetryable, readyClassFresh, readyClassStage1Only, readyClassReconciling, readyClassTerminalEgress, readyTerminalEgressPrunedCount, readyClassReadyOnlyEgress, readyReadyOnlyEgressPrunedCount, readyClassOther, readyOtherDiagnosticPatterns, readyOtherFreshMissingPatterns, readyLegacyQuarantineAttempted, readyLegacyQuarantineSucceeded, readyShadowEligibleIds, readyShadowPreparedIds, readyShadowFreshIds, readyShadowReconcilingIds, walletDrainShadowCount, walletDrainShadowHeadPaymentId, walletDrainShadowHeadRefundId, walletDrainShadowHeadKind, walletDrainSelectedHeadKind, walletDrainSelectedHeadPaymentId, walletDrainSelectedHeadRefundId, walletDrainSelectedHeadParity, walletDrainPreExecutionHeadKind, walletDrainPreExecutionHeadPaymentId, walletDrainPreExecutionHeadRefundId, walletDrainNonEmptyParity, walletDrainNonMoneyCertification, readyCoverageCount: readyCoverageAllIds.length, readyCoverageTruncated, readyCoverageIndexed, readyCoverageMissing, readyHeadTruncated, readyCoverageOutsideHead, readyResidencyCount, readyResidencyMissing, readyResidencyBackfilled, readyEligibleSetParity, readyFreshSetParity, readyReconcilingSetParity, readyAuthorityCertified, readySchedulerUsable, readyBaselineCertified, readyRotationStart, readyRotationNext, readyRotationCas, readyRotationCycleMax, readyRotationCycleGeneration, readyWindowCertified, readyExecutionSource: useReadyExecution ? "ready" : "legacy" })

  return NextResponse.json({ processed: results.length, results, refundIntake: { processed: refundResults.length, results: refundResults }, refundPass, settlementDispatchDiscovery: { count: freshDispatchIds.length }, settlementReconcilingDiscovery: { count: settlementReconcilingDiscoveryIds.length }, staleRetryReconcilingDiscovery: { count: staleRetryReconcilingDiscoveryIds.length }, settlementReconcilingEvidence, boundedPipeline: { concurrency: BOUNDED_PIPELINE_CONCURRENCY, settlementPeakInFlight: settlementPipelinePeakInFlight, refundIntakePeakInFlight }, piCreateBackpressure: { active: piCreateBackpressureActive(), untilMs: piCreateBackpressureUntilMs, unavailable: piCreateBackpressureUnavailable }, readyHygiene: { terminalEgressClassified: readyClassTerminalEgress, terminalEgressPruned: readyTerminalEgressPrunedCount, readyOnlyEgressClassified: readyClassReadyOnlyEgress, readyOnlyEgressPruned: readyReadyOnlyEgressPrunedCount, other: readyClassOther, otherDiagnosticPatterns: readyOtherDiagnosticPatterns, otherFreshMissingPatterns: readyOtherFreshMissingPatterns, legacyQuarantineAttempted: readyLegacyQuarantineAttempted, legacyQuarantineSucceeded: readyLegacyQuarantineSucceeded }, walletDrainFairness: { class: walletDrainFairnessClass, selectedLane: preHead?.lane ?? null, preparedOverride: preHead?.lane === "prepared", freshCreateSuppressed: piCreateBackpressureActive() && (readyShadowFreshCreateIds?.length ?? 0) > 0 }, walletDrainBurst: { limit: WALLET_DRAIN_BURST_LIMIT, budgetMs: WALLET_DRAIN_BURST_BUDGET_MS, durationMs: walletDrainBurstDurationMs, budgetExhausted: walletDrainBudgetExhausted, immediateDrainMode, periodicFreshCreateDetected, deferredDbCount: walletDrainDeferredDbCount, settlementAttempts: walletDrainBurstSettlementAttempts, refundAttempts: walletDrainBurstRefundAttempts, stopReason: walletDrainBurstStopReason, lanes: walletDrainBurstLanes, continuationScheduled: walletDrainContinuationScheduled, kickGateReleased: walletDrainKickGateReleased, kickGateReleaseDeferred: walletDrainKickGateReleaseDeferred }, drainLease: "acquired" })
  } finally {
    const released = await drainLease.release()
    if (released) console.log("[P7J5 LEASE] released")
    else console.warn("[P7J5 LEASE] release skipped or ownership changed")
  }
}
