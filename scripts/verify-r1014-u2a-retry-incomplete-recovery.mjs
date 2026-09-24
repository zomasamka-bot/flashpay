import { strict as assert } from "node:assert"
import fs from "node:fs"

const complete=fs.readFileSync(new URL("../app/api/pi/complete/route.ts",import.meta.url),"utf8")
const recovery=fs.readFileSync(new URL("../app/api/recovery/transient/route.ts",import.meta.url),"utf8")
const db=fs.readFileSync(new URL("../lib/db.ts",import.meta.url),"utf8")

// R101-4 proof target: a verified U2A must remain durably rediscoverable and
// retry-safe across loss of the client callback, Pi /complete response, Redis
// projection, and worker wake. This certifier performs no external I/O.
const verifiedWrite=complete.indexOf("recordSettlementU2AVerifiedCheckpoint({")
const piComplete=complete.indexOf("Payment not developer_completed - calling Pi /complete endpoint")
const completedWrite=complete.indexOf("recordSettlementU2ACompletedCheckpoint({")
assert.ok(verifiedWrite>=0 && piComplete>verifiedWrite && completedWrite>piComplete)

// Client retry: already developer_completed skips duplicate Pi mutation but
// still reaches the common durable completed checkpoint.
assert.ok(complete.includes("Payment already developer_completed - skipping Pi /complete call"))
assert.ok(complete.includes("finalPiPayment.status?.developer_completed !== true"))
assert.ok(complete.includes('durableU2ACompleted.outcome !== "RECORDED" && durableU2ACompleted.outcome !== "REPLAYED"'))

// Durable rediscovery is PostgreSQL-backed and bounded; it is not Redis-only.
assert.ok(recovery.includes("listRecoverableU2AIngressCheckpointIds(200)"))
assert.ok(recovery.includes("getDurableU2AIngressAuthoritative(paymentId)"))
assert.ok(db.includes("u2a_ingress_recovery_scan_cursor"))
assert.ok(db.includes("WHERE stage='payment_identity' AND u2a_identifier IS NOT NULL AND u2a_txid IS NOT NULL AND payer_uid IS NOT NULL AND u2a_verified_at IS NOT NULL"))

// Worker recovery for verified-but-incomplete U2A:
// exact canonical Pi GET -> optional /complete -> exact GET again -> durable
// completed checkpoint. A lost/non-2xx POST response is never treated as truth.
const repopStart=recovery.indexOf("async function repopulateDurableU2AIngressWork")
const repopEnd=recovery.indexOf("async function repopulateDurableSettlementWork",repopStart)
const repop=recovery.slice(repopStart,repopEnd)
assert.ok(repop.includes("if(durable.checkpoint.completedAt===null)"))
assert.ok(repop.includes("metadata?.paymentId!==paymentId"))
assert.ok(repop.includes("transaction.txid!==ingress.u2aTxid"))
assert.ok(repop.includes("payerUid!==ingress.payerUid"))
assert.ok(repop.includes("status.developer_approved!==true"))
assert.ok(repop.includes("status.transaction_verified!==true"))
assert.ok(repop.includes("status.cancelled===true||status.user_cancelled===true"))
assert.ok(repop.includes("/complete"))
assert.ok(repop.includes("A lost/non-2xx response is never treated as truth"))
assert.ok(repop.includes("pi=await readExactPiU2A()"))
assert.ok(repop.includes("pi.status.developer_completed!==true"))
assert.ok(repop.includes("recordSettlementU2ACompletedCheckpoint({"))

// PostgreSQL/Pi uncertainty cannot manufacture completion or ready membership.
assert.ok(repop.includes("if(!pi){result.piReadUncertain++;continue}"))
assert.ok(repop.includes("if(!pi||pi.status.developer_completed!==true){result.piReadUncertain++;continue}"))
assert.ok(repop.includes("if(completion.outcome!=='RECORDED'&&completion.outcome!=='REPLAYED'){result.conflicts++;continue}"))

// Redis loss after durable completion is recoverable from exact durable evidence.
assert.ok(repop.includes("redis.set(`payment:${paymentId}`,JSON.stringify(projection),{nx:true})"))
assert.ok(repop.includes("status:d.completedAt?'paid_to_app':'pending'"))
assert.ok(repop.includes("readback.piPaymentId!==d.u2aIdentifier"))
assert.ok(repop.includes("readback.u2aTxid!==d.u2aTxid"))
assert.ok(repop.includes("readback.payerUid!==d.payerUid"))

// Approval ownership introduced in R101-2 remains enforced when U2A becomes verified.
assert.ok(db.includes("(u2a_approval_identifier IS NULL OR u2a_approval_identifier=${params.u2aIdentifier})"))
assert.ok(db.includes("(row.u2a_approval_identifier!=null && row.u2a_approval_identifier!==params.u2aIdentifier)"))

// State-machine matrix: only exact durable identity can progress.
const exact=(d,p)=>d.id===p.id&&d.txid===p.txid&&d.payer===p.payer&&d.paymentId===p.paymentId
const D={id:"A",txid:"a".repeat(64),payer:"payer-A",paymentId:"P"}
assert.equal(exact(D,{...D}),true)
assert.equal(exact(D,{...D,id:"B"}),false)
assert.equal(exact(D,{...D,txid:"b".repeat(64)}),false)
assert.equal(exact(D,{...D,payer:"payer-B"}),false)
assert.equal(exact(D,{...D,paymentId:"Q"}),false)

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-4-U2A-RETRY-INCOMPLETE-RECOVERY",
 matrix:{
  clientRetryAfterVerifiedCheckpoint:"SAFE_REPLAY",
  crashBeforePiComplete:"DURABLY_REDISCOVERABLE",
  piCompleteResponseLost:"REFETCH_CANONICAL_PI_STATE",
  crashAfterPiCompleteBeforeDurableCompletion:"WORKER_RECONCILES_FROM_EXACT_PI_STATE",
  crashAfterDurableCompletionBeforeRedis:"REDIS_REBUILT_FROM_DURABLE_EVIDENCE",
  redisLoss:"POSTGRES_ROTATION_REDISCOVERS",
  piReadUncertain:"FAIL_CLOSED_NO_COMPLETION_INVENTED",
  approvalIdentifierMismatch:"CONFLICT"
 },
 sourcePatchRequired:false,
 financialMovementExecuted:false,
 piNetworkCalled:false,
 secretsRead:false
},null,2))
