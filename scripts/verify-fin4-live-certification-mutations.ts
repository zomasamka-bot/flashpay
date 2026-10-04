import fs from "node:fs"
const h=fs.readFileSync("lib/fin4-live-certification.ts","utf8")
const a=fs.readFileSync("lib/a2u-executor.ts","utf8")
const l=fs.readFileSync("lib/a2u-locked-executor.ts","utf8")
const c=fs.readFileSync("app/api/pi/complete/route.ts","utf8")
const o=fs.readFileSync("app/api/certification/fin4-trigger/route.ts","utf8")
const ra=fs.readFileSync("app/api/certification/fin4-trigger-a/route.ts","utf8")
const rb=fs.readFileSync("app/api/certification/fin4-trigger-b/route.ts","utf8")

const validHarness=(s:string)=>[
  'process.env.VERCEL_ENV !== "production" || process.env.FLASHPAY_FIN4_ARMED !== "1"',
  'paymentA === paymentB',
  'aProcess !== bProcess && aWallet === sourceWallet && bWallet === sourceWallet',
  'FIN4_FAIL_CLOSED_DISTINCT_PROCESS_BARRIER_TIMEOUT',
  'redis.set(launchKey(runId), "1", { nx: true, ex: LAUNCH_TTL_SECONDS })',
  'FIN4_FAIL_CLOSED_CONTROLLED_LAUNCH_REQUIRED',
  'export async function fin4BestEffortEvent',
  'flashpay:cert:fin4:r4d:v1:',
].every(x=>s.includes(x)) && !s.includes('submitTransaction(')
const validIntegration=(s:string)=>{
  const durable=s.indexOf('recordSettlementHorizonCheckpoint({')
  const verified=s.indexOf('fin4BestEffortEvent(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED"')
  const release=s.indexOf('await walletLock.release()')
  const released=s.indexOf('fin4BestEffortEvent(ctx.paymentId, ctx.payment.a2uFromAddress, fin4State, "LOCK_RELEASED")')
  return durable>=0&&verified>durable&&release>=0&&released>release&&!s.includes('"LOCK_RELEASING"')
}
const validLaunch=(s:string)=>s.includes('Promise.all([invokeRole(origin, runId, "A", bypassSecret), invokeRole(origin, runId, "B", bypassSecret)])')&&s.includes('process.env.VERCEL_URL')&&s.includes('process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()')&&s.includes('FIN4_FAIL_CLOSED_AUTOMATION_BYPASS_UNAVAILABLE')&&s.includes('"x-vercel-protection-bypass": bypassSecret')&&!s.includes('executeA2URecovery(')&&!s.includes('submitTransaction(')
const validRole=(s:string,role:string)=>s.includes(`fin4ArmedPaymentForRole(runId, "${role}")`)&&s.includes('fin4RequireControlledLaunch(runId)')&&s.includes('executeA2URecovery(paymentId)')&&!s.includes('body.paymentId')&&!s.includes('body.role')&&!s.includes('submitTransaction(')
const validComplete=(s:string)=>s.includes('getDurableU2AIngressAuthoritative')&&s.includes('const ingressCompletedAt = ingress.completedAt')&&s.includes('if (ingressCompletedAt === null ||')&&s.includes('payment.payerUidCapturedAt = durableCanonicalTimes?.verifiedAt')&&s.includes('payment.paidAt = durableCanonicalTimes.completedAt')
const validRepair=(s:string)=>s.includes('isF24PreA2UTimestampRepairSafe')&&s.includes("current.a2uPaymentId~=nil or current.a2uTxid~=nil")&&s.includes("current.refundPaymentId~=nil or current.refundTxid~=nil")&&s.includes('current.redisProjectionVersion~=version then return 0')&&s.includes('const repairArgs: [string, string, string, string, string, string, string, string, string, string]')&&s.includes('redis.eval<[string, string, string, string, string, string, string, string, string, string], number>')&&s.includes('typeof payment.merchantUid !== "string"')&&s.includes('typeof payment.piPaymentId !== "string"')&&s.includes('typeof payment.u2aTxid !== "string"')&&s.includes('typeof payment.payerUid !== "string"')&&s.includes('const completedAt = d.completedAt')&&s.includes('if (completedAt === null) return null')&&s.includes('exactPiAuthority')&&s.includes('status?.developer_completed === true')

let expected=0
function mutate(name:string,source:string,from:string,to:string,valid:(s:string)=>boolean){
  const m=source.split(from).join(to); if(m===source)throw new Error(`mutation not applied: ${name}`); if(valid(m))throw new Error(`unexpected mutation pass: ${name}`); expected++
}
mutate('remove_production_gate',h,'process.env.VERCEL_ENV !== "production" || ','',validHarness)
mutate('allow_same_payment',h,'paymentA === paymentB','false',validHarness)
mutate('remove_distinct_process',h,'aProcess !== bProcess && ','',validHarness)
mutate('remove_same_wallet',h,' && aWallet === sourceWallet && bWallet === sourceWallet','',validHarness)
mutate('remove_one_shot_launch',h,'{ nx: true, ex: LAUNCH_TTL_SECONDS }','{ ex: LAUNCH_TTL_SECONDS }',validHarness)
mutate('remove_controlled_launch_hold',h,'FIN4_FAIL_CLOSED_CONTROLLED_LAUNCH_REQUIRED','FIN4_CONTROLLED_LAUNCH_OPTIONAL',validHarness)
mutate('post_movement_throwing_telemetry',a,'fin4BestEffortEvent(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED"','fin4Event(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED"',validIntegration)
mutate('move_submit_verified_before_durable',a,'const durableHorizon = await recordSettlementHorizonCheckpoint({','await fin4BestEffortEvent(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED", { txidFromHorizon, preparedHash, preparedSequence: transaction.sequence })\n    const durableHorizon = await recordSettlementHorizonCheckpoint({',validIntegration)
mutate('reintroduce_pre_release_telemetry',a,'await walletLock.release()','await fin4BestEffortEvent(ctx.paymentId, ctx.payment.a2uFromAddress, fin4State, "LOCK_RELEASING")\n        await walletLock.release()',validIntegration)
mutate('sequential_split_launch',o,'Promise.all([invokeRole(origin, runId, "A", bypassSecret), invokeRole(origin, runId, "B", bypassSecret)])','[await invokeRole(origin, runId, "A", bypassSecret), await invokeRole(origin, runId, "B", bypassSecret)]',validLaunch)
mutate('remove_automation_bypass_header',o,'"x-vercel-protection-bypass": bypassSecret','"x-fin4-no-bypass": bypassSecret',validLaunch)
mutate('remove_automation_bypass_env_gate',o,'process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()','process.env.FLASHPAY_FIN4_RUN_ID?.trim()',validLaunch)
mutate('remove_exact_deployment_origin',o,'process.env.VERCEL_URL','process.env.NEXT_PUBLIC_APP_URL',validLaunch)
mutate('allow_role_a_client_payment',ra,'fin4ArmedPaymentForRole(runId, "A")','(await request.json()).paymentId',s=>validRole(s,'A'))
mutate('allow_role_b_client_payment',rb,'fin4ArmedPaymentForRole(runId, "B")','(await request.json()).paymentId',s=>validRole(s,'B'))
mutate('complete_new_date_payer',c,'durableCanonicalTimes?.verifiedAt ?? payment.payerUidCapturedAt','payment.payerUidCapturedAt',validComplete)
mutate('complete_new_date_paid',c,'payment.paidAt = durableCanonicalTimes.completedAt','payment.paidAt = new Date().toISOString()',validComplete)
mutate('complete_removes_completed_at_narrowing',c,'if (ingressCompletedAt === null ||','if (false ||',validComplete)
mutate('repair_allows_advanced_settlement',l,'current.a2uPaymentId~=nil or current.a2uTxid~=nil','false',validRepair)
mutate('repair_allows_refund',l,'current.refundPaymentId~=nil or current.refundTxid~=nil','false',validRepair)
mutate('repair_removes_version_fence',l,'current.redisProjectionVersion~=version then return 0','false then return 0',validRepair)
mutate('repair_argv_tuple_type_regression',l,'redis.eval<[string, string, string, string, string, string, string, string, string, string], number>','redis.eval<[string], number>',validRepair)
mutate('repair_removes_optional_identity_narrowing',l,'typeof payment.merchantUid !== "string"','false',validRepair)
mutate('repair_removes_completed_at_narrowing',l,'if (completedAt === null) return null','if (false) return null',validRepair)
mutate('repair_weakens_pi_completion',l,'status?.developer_completed === true','true',validRepair)

if(!validHarness(h)||!validIntegration(a)||!validLaunch(o)||!validRole(ra,'A')||!validRole(rb,'B')||!validComplete(c)||!validRepair(l))throw new Error('original FIN4 R4 invalid')
console.log(`FIN4_LIVE_R4D_MUTATIONS=PASS expected_failures=${expected} unexpected_passes=0`)
