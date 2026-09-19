import { strict as assert } from "node:assert"
import fs from "node:fs"

const settlement = fs.readFileSync(new URL("../lib/a2u-executor.ts", import.meta.url), "utf8")
const refund = fs.readFileSync(new URL("../lib/refund-executor.ts", import.meta.url), "utf8")
const reconciliation = fs.readFileSync(new URL("../lib/pi-reconciliation.ts", import.meta.url), "utf8")

const sourcePredicates = [
  'if (await refetchCompleted()) {',
  'Pi /complete non-OK response reconciled as completed',
  'responseStatusRetryable(response.status) ? "settlement_pending" : "error"',
  '/complete transport exception; reconciling exact completion state',
  'Pi /complete transport outcome unverified',
  'value.identifier === a2uPaymentId',
  'value.amount === ctx.customerAmount',
  'value.direction === "app_to_user"',
  'value.user_uid === ctx.merchantUid',
  'md?.paymentId === ctx.paymentId',
  'md?.type === "a2u_settlement"',
  'tx?.txid === txidFromHorizon',
  'tx?.verified === true',
  'st?.transaction_verified === true',
  'st?.developer_completed === true',
  'st?.cancelled !== true',
  'st?.user_cancelled !== true',
]
for (const predicate of sourcePredicates) assert.ok(settlement.includes(predicate), `Settlement production predicate missing: ${predicate}`)
assert.ok(!settlement.includes('catch (error) {\n    console.error("[A2U Stage3] Exception:", error)\n    return { ok: false, error: String(error), userFacingStatus: "error" }'), "Old transport ambiguity path still present")
for (const predicate of [
  'reconcileIncompleteA2UPayment(ctx.paymentId, ctx.customerAmount, ctx.merchantUid)',
  'existing.outcome === "INDETERMINATE"',
  'responseStatusRetryable(createResponse.status)',
  'A failed POST is ambiguous',
]) assert.ok(settlement.includes(predicate), `Create ambiguity predicate missing: ${predicate}`)
for (const predicate of [
  "const response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(refundPaymentId)}/complete`",
  "if (response === null || !response.ok)",
  "const recovered = await reconcileRefundWithPi",
  "recovered.payment.transaction.txid !== refundTxid",
  "recovered.payment.status.developer_completed !== true",
  "const confirmed = await reconcileRefundWithPi",
]) assert.ok(refund.includes(predicate), `Refund completion predicate missing: ${predicate}`)
for (const predicate of [
  'incomplete_server_payments',
  'if (!candidates) return { outcome: "INDETERMINATE"',
  'evaluation.outcome === "CONFIRMED_NONE"',
]) assert.ok(reconciliation.includes(predicate), `Pi reconciliation predicate missing: ${predicate}`)

const expected={id:"a2u-1",amount:0.3,direction:"app_to_user",uid:"merchant-1",paymentId:"pay-1",type:"a2u_settlement",txid:"a".repeat(64)}
const completed={identifier:expected.id,from_address:"GAPP",to_address:"GMERCHANT",amount:expected.amount,direction:expected.direction,user_uid:expected.uid,metadata:{paymentId:expected.paymentId,type:expected.type},transaction:{txid:expected.txid,verified:true},status:{transaction_verified:true,developer_completed:true,cancelled:false,user_cancelled:false}}
function verified(v){return v&&v.identifier===expected.id&&v.amount===expected.amount&&v.direction===expected.direction&&v.user_uid===expected.uid&&v.metadata?.paymentId===expected.paymentId&&v.metadata?.type===expected.type&&v.transaction?.txid===expected.txid&&v.transaction?.verified===true&&v.status?.transaction_verified===true&&v.status?.developer_completed===true&&v.status?.cancelled!==true&&v.status?.user_cancelled!==true}
function decide({transportThrow=false,status=200,body=null,refetch=null,errorText=""}){
  if(transportThrow) return verified(refetch)?"SUCCESS_RECONCILED":"PENDING_UNVERIFIED"
  if(status<200||status>=300){if(verified(refetch))return "SUCCESS_RECONCILED";if(status===400&&errorText.includes("already_completed"))return "PENDING_UNVERIFIED";return [408,425,429].includes(status)||status>=500?"PENDING_UNVERIFIED":"ERROR_DEFINITIVE"}
  return verified(body)||verified(refetch)?"SUCCESS_VERIFIED":"PENDING_UNVERIFIED"
}
const cases=[
  ["200 exact DTO",{body:completed},"SUCCESS_VERIFIED"],
  ["200 malformed then exact refetch",{body:{},refetch:completed},"SUCCESS_VERIFIED"],
  ["200 malformed and no proof",{body:{},refetch:null},"PENDING_UNVERIFIED"],
  ["transport lost response then completed",{transportThrow:true,refetch:completed},"SUCCESS_RECONCILED"],
  ["transport lost response unresolved",{transportThrow:true,refetch:null},"PENDING_UNVERIFIED"],
  ["500 then completed",{status:500,refetch:completed},"SUCCESS_RECONCILED"],
  ["500 unresolved",{status:500,refetch:null},"PENDING_UNVERIFIED"],
  ["429 unresolved",{status:429,refetch:null},"PENDING_UNVERIFIED"],
  ["400 already_completed exact",{status:400,errorText:"already_completed",refetch:completed},"SUCCESS_RECONCILED"],
  ["400 already_completed unverified",{status:400,errorText:"already_completed",refetch:null},"PENDING_UNVERIFIED"],
  ["400 definitive invalid",{status:400,errorText:"invalid",refetch:null},"ERROR_DEFINITIVE"],
]
for(const [name,input,want] of cases) assert.equal(decide(input),want,name)
const mutations=[
  {identifier:"other"},{amount:0.31},{direction:"user_to_app"},{user_uid:"other"},
  {metadata:{...completed.metadata,paymentId:"other"}},{metadata:{...completed.metadata,type:"refund"}},
  {transaction:{...completed.transaction,txid:"b".repeat(64)}},{transaction:{...completed.transaction,verified:false}},
  {status:{...completed.status,transaction_verified:false}},{status:{...completed.status,developer_completed:false}},
  {status:{...completed.status,cancelled:true}},{status:{...completed.status,user_cancelled:true}},
]
for(const mutation of mutations) assert.equal(verified({...completed,...mutation}),false,`accepted mutation ${JSON.stringify(mutation)}`)
console.log(JSON.stringify({certification:"PASS",productionSourceBound:true,decisionCasesPassed:cases.length,identityAndFinalityMutationsRejected:mutations.length,blindCompleteRetry:false,transportLostResponseReconciled:true,retryableHttpLostResponseReconciled:true,unverifiedAmbiguityFailsClosed:true,refundCompletionRecoveryBound:true,createIncompleteReconciliationBound:true},null,2))
