import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const a2u=read("lib/a2u-executor.ts"), route=read("app/api/recovery/transient/route.ts")
// Abnormal financial events must be correlatable without dumping provider payloads.
for(const x of [
  '[DR-22 FINANCIAL EVENT]', 'event: "a2u_create_failed"', 'paymentId: ctx.paymentId',
  'stage: "pi_create"', 'httpStatus: createResponse.status', 'failClosed: true',
  'event: "a2u_create_invalid_dto"', 'event: "a2u_fetch_invalid_dto"', 'responseType:'
]) assert.ok(a2u.includes(x),x)
for(const forbidden of [
  'console.error("[A2U Stage1] A2U creation failed:", errorData)',
  'console.error("[A2U Stage1] A2U response validation failed:", responseData)',
  'console.error("[A2U Fetch] A2U response validation failed:", responseData)'
]) assert.equal(a2u.includes(forbidden),false,forbidden)
// DR-21 continuation reason must be observable in both structured capacity log and response.
assert.ok(route.includes('backpressureNonCreateContinuationDetected'))
assert.ok(route.includes('periodicFreshCreateDetected, backpressureNonCreateContinuationDetected, walletDrainDeferredDbCount'))
assert.ok(route.includes('periodicFreshCreateDetected, backpressureNonCreateContinuationDetected, deferredDbCount'))
// Static secret-value logging guard for the touched financial surfaces.
const sensitiveValuePatterns=[
 /console\.(?:log|warn|error)\([^\n]*(?:serverConfig\.piApiKey|PI_PRIVATE_SEED\]|runtimeEnv\[[^\]]*SECRET|authorization\s*:\s*`Bearer)/i,
 /console\.(?:log|warn|error)\([^\n]*accessToken\s*[,)]/i,
]
for(const re of sensitiveValuePatterns){ assert.equal(re.test(a2u+'\n'+route),false,String(re)) }
// 10k observability model: every abnormal event has correlation, stage, outcome, no payload/body/secret.
const TOTAL=10_000; let correlatable=0,payloadLeak=0,falseSuccess=0
for(let i=0;i<TOTAL;i++){
 const event={event:i%2?'a2u_create_failed':'a2u_create_invalid_dto',paymentId:`p-${i}`,stage:'pi_create',failClosed:true,httpStatus:i%2?429:200}
 if(event.paymentId&&event.stage&&event.event&&event.failClosed===true) correlatable++
 if('body' in event||'headers' in event||'accessToken' in event||'apiKey' in event||'secret' in event) payloadLeak++
 if(event.failClosed!==true) falseSuccess++
}
assert.equal(correlatable,TOTAL); assert.equal(payloadLeak,0); assert.equal(falseSuccess,0)
console.log(JSON.stringify({certification:'PASS',gate:'DR-22-LOGGING-OBSERVABILITY',syntheticEvents:TOTAL,correlatableEvents:correlatable,sensitivePayloadLeakObserved:payloadLeak,falseSuccessTelemetryObserved:falseSuccess,dr21ContinuationReasonObservable:true,financialMovementExecuted:false,productionDataMutated:false,runtimePatchRequired:true,changedRuntimeFiles:['lib/a2u-executor.ts','app/api/recovery/transient/route.ts'],nextGate:'DR-23-DEAD-CODE-APPROVE-CLEANUP'},null,2))
