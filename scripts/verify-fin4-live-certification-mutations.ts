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
  'redisPurpose: "audit_and_one_shot_coordination_only"',
  'flashpay:cert:fin4:r4e:v1:',
  'import { AsyncLocalStorage } from "node:async_hooks"',
  'const CAPABILITY_TTL_MS = 60_000',
  'crypto.createHmac("sha256", automationBypassSecret())',
  'flashpay-fin4-r4e-capability:${encodedPayload}',
  'timingSafeEqualText(suppliedSignature, expectedSignature)',
  'parsed.runId !== runId || parsed.role !== role || parsed.paymentId !== paymentId',
  'parsed.deploymentHost !== expectedHost',
  'parsed.exp - parsed.iat !== CAPABILITY_TTL_MS',
  'redis.set(capabilityUseKey(capability), "1", { nx: true, ex: CAPABILITY_USE_TTL_SECONDS })',
  'invocationCapabilityContext.run(capability, work)',
  'const capability = invocationCapabilityContext.getStore()',
  'FIN4_FAIL_CLOSED_SCOPED_CAPABILITY_REQUIRED',
  'export async function fin4BestEffortEvent',
].every(x=>s.includes(x)) && !s.includes('submitTransaction(') && !s.includes('redis.get<string>(launchKey(') && !s.includes('fin4RequireControlledLaunch') && !s.includes('flashpay:cert:fin4:r4d:v1:')

const validIntegration=(s:string)=>{
  const durable=s.indexOf('recordSettlementHorizonCheckpoint({')
  const verified=s.indexOf('fin4BestEffortEvent(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED"')
  const release=s.indexOf('await walletLock.release()')
  const released=s.indexOf('fin4BestEffortEvent(ctx.paymentId, ctx.payment.a2uFromAddress, fin4State, "LOCK_RELEASED")')
  return durable>=0&&verified>durable&&release>=0&&released>release&&!s.includes('"LOCK_RELEASING"')
}

const validLaunch=(s:string)=>s.includes('const [a,b] = await Promise.all([')&&s.includes('fin4ClaimLaunchForArmedRun(runId)')&&s.includes('const capabilityA = fin4IssueInvocationCapability(runId, "A")')&&s.includes('const capabilityB = fin4IssueInvocationCapability(runId, "B")')&&s.includes('invokeRole(origin, runId, "A", bypassSecret, capabilityA)')&&s.includes('invokeRole(origin, runId, "B", bypassSecret, capabilityB)')&&s.includes('"x-flashpay-fin4-capability": capability')&&s.includes('"x-vercel-protection-bypass": bypassSecret')&&s.includes('process.env.VERCEL_URL')&&s.includes('process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()')&&!s.includes('executeA2URecovery(')&&!s.includes('submitTransaction(')&&!s.includes('console.log(capabilityA)')&&!s.includes('console.log(capabilityB)')

const validPreflight=(s:string)=>{
  const start=s.indexOf('export async function GET(request: NextRequest)')
  const end=s.indexOf('async function invokeRole(',start)
  if(start<0||end<=start)return false
  const g=s.slice(start,end)
  return g.includes('fin4AutomationBypassPresent()')&&g.includes('action: "preflight"')&&g.includes('financialAuthorityMutated: false')&&!g.includes('fin4ClaimLaunchForArmedRun')&&!g.includes('fetch(')&&!g.includes('executeA2URecovery')&&!g.includes('submitTransaction(')
}

const validRole=(s:string,role:string)=>s.includes(`fin4ArmedPaymentForRole(runId, "${role}")`)&&s.includes(`fin4ValidateInvocationCapability(request.headers.get("x-flashpay-fin4-capability"), runId, "${role}", paymentId)`)&&s.includes('await fin4ConsumeInvocationCapability(capability)')&&s.includes('fin4RunWithInvocationCapability(capability, async () =>')&&s.includes('executeA2URecovery(paymentId)')&&!s.includes('fin4RequireControlledLaunch')&&!s.includes('body.paymentId')&&!s.includes('body.role')&&!s.includes('submitTransaction(')

const validComplete=(s:string)=>s.includes('getDurableU2AIngressAuthoritative')&&s.includes('const ingressCompletedAt = ingress.completedAt')&&s.includes('if (ingressCompletedAt === null ||')&&s.includes('payment.payerUidCapturedAt = durableCanonicalTimes?.verifiedAt')&&s.includes('payment.paidAt = durableCanonicalTimes.completedAt')
const validRepair=(s:string)=>s.includes('isF24PreA2UTimestampRepairSafe')&&s.includes("current.a2uPaymentId~=nil or current.a2uTxid~=nil")&&s.includes("current.refundPaymentId~=nil or current.refundTxid~=nil")&&s.includes('current.redisProjectionVersion~=version then return 0')&&s.includes('const repairArgs: [string, string, string, string, string, string, string, string, string, string]')&&s.includes('redis.eval<[string, string, string, string, string, string, string, string, string, string], number>')&&s.includes('typeof payment.merchantUid !== "string"')&&s.includes('typeof payment.piPaymentId !== "string"')&&s.includes('typeof payment.u2aTxid !== "string"')&&s.includes('typeof payment.payerUid !== "string"')&&s.includes('const completedAt = d.completedAt')&&s.includes('if (completedAt === null) return null')&&s.includes('exactPiAuthority')&&s.includes('status?.developer_completed === true')

const validEvidence=(s:string)=>s.includes('request.nextUrl.searchParams.get("evidence") === "B"')&&s.includes('getDurableU2AIngressAuthoritative(paymentId)')&&s.includes('readSettlementCreatePiEvidence(checkpoint.u2aIdentifier)')&&s.includes('evaluateFinancialRecoveryPiCandidates({')&&s.includes('moneyMovementProven: false')&&!s.includes('executeA2URecovery(')&&!s.includes('submitTransaction(')&&!s.includes('recordSettlementA2UCreatedCheckpoint(')&&!s.includes('persistCheckpointMerged(')

let expected=0
function mutate(name:string,source:string,from:string,to:string,valid:(s:string)=>boolean){
  const m=source.split(from).join(to); if(m===source)throw new Error(`mutation not applied: ${name}`); if(valid(m))throw new Error(`unexpected mutation pass: ${name}`); expected++
}

// Harness/capability mutations.
mutate('remove_production_gate',h,'process.env.VERCEL_ENV !== "production" || ','',validHarness)
mutate('allow_same_payment',h,'paymentA === paymentB','false',validHarness)
mutate('reuse_r4d_namespace',h,'flashpay:cert:fin4:r4e:v1:','flashpay:cert:fin4:r4d:v1:',validHarness)
mutate('remove_distinct_process',h,'aProcess !== bProcess && ','',validHarness)
mutate('remove_same_wallet',h,' && aWallet === sourceWallet && bWallet === sourceWallet','',validHarness)
mutate('remove_one_shot_launch',h,'{ nx: true, ex: LAUNCH_TTL_SECONDS }','{ ex: LAUNCH_TTL_SECONDS }',validHarness)
mutate('remove_coordination_only_classification',h,'redisPurpose: "audit_and_one_shot_coordination_only"','redisPurpose: "authority"',validHarness)
mutate('remove_async_context',h,'import { AsyncLocalStorage } from "node:async_hooks"','',validHarness)
mutate('weaken_capability_ttl',h,'const CAPABILITY_TTL_MS = 60_000','const CAPABILITY_TTL_MS = 3_600_000',validHarness)
mutate('remove_hmac',h,'crypto.createHmac("sha256", automationBypassSecret())','crypto.createHash("sha256")',validHarness)
mutate('remove_hmac_domain_separation',h,'flashpay-fin4-r4e-capability:${encodedPayload}','${encodedPayload}',validHarness)
mutate('remove_signature_timing_safe_check',h,'timingSafeEqualText(suppliedSignature, expectedSignature)','suppliedSignature === expectedSignature',validHarness)
mutate('remove_role_scope',h,'parsed.runId !== runId || parsed.role !== role || parsed.paymentId !== paymentId','parsed.runId !== runId || false || parsed.paymentId !== paymentId',validHarness)
mutate('remove_payment_scope',h,'parsed.runId !== runId || parsed.role !== role || parsed.paymentId !== paymentId','parsed.runId !== runId || parsed.role !== role || false',validHarness)
mutate('remove_deployment_scope',h,'parsed.deploymentHost !== expectedHost','false',validHarness)
mutate('remove_exact_ttl_enforcement',h,'parsed.exp - parsed.iat !== CAPABILITY_TTL_MS','false',validHarness)
mutate('remove_capability_one_shot',h,'{ nx: true, ex: CAPABILITY_USE_TTL_SECONDS }','{ ex: CAPABILITY_USE_TTL_SECONDS }',validHarness)
mutate('remove_invocation_context_run',h,'invocationCapabilityContext.run(capability, work)','work()',validHarness)
mutate('remove_boundary_context_read',h,'const capability = invocationCapabilityContext.getStore()','const capability = null',validHarness)
mutate('weaken_boundary_fail_closed',h,'FIN4_FAIL_CLOSED_SCOPED_CAPABILITY_REQUIRED','FIN4_SCOPED_CAPABILITY_OPTIONAL',validHarness)
mutate('reintroduce_launch_claim_read_authority',h,'const capability = invocationCapabilityContext.getStore()','const launch = await redis.get<string>(launchKey(cfg.runId))\n  const capability = invocationCapabilityContext.getStore()',validHarness)

// Financial integration ordering mutations.
mutate('post_movement_throwing_telemetry',a,'fin4BestEffortEvent(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED"','fin4Event(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED"',validIntegration)
mutate('move_submit_verified_before_durable',a,'const durableHorizon = await recordSettlementHorizonCheckpoint({','await fin4BestEffortEvent(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED", { txidFromHorizon, preparedHash, preparedSequence: transaction.sequence })\n    const durableHorizon = await recordSettlementHorizonCheckpoint({',validIntegration)
mutate('reintroduce_pre_release_telemetry',a,'await walletLock.release()','await fin4BestEffortEvent(ctx.paymentId, ctx.payment.a2uFromAddress, fin4State, "LOCK_RELEASING")\n        await walletLock.release()',validIntegration)

// Orchestrator mutations.
mutate('sequential_split_launch',o,'const [a,b] = await Promise.all([','const [a,b] = [await ',validLaunch)
mutate('remove_automation_bypass_header',o,'"x-vercel-protection-bypass": bypassSecret','"x-fin4-no-bypass": bypassSecret',validLaunch)
mutate('remove_capability_header',o,'"x-flashpay-fin4-capability": capability','"x-flashpay-fin4-no-capability": capability',validLaunch)
mutate('remove_automation_bypass_env_gate',o,'process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()','process.env.FLASHPAY_FIN4_RUN_ID?.trim()',validLaunch)
mutate('remove_exact_deployment_origin',o,'process.env.VERCEL_URL','process.env.NEXT_PUBLIC_APP_URL',validLaunch)
mutate('reuse_a_capability_for_b',o,'invokeRole(origin, runId, "B", bypassSecret, capabilityB)','invokeRole(origin, runId, "B", bypassSecret, capabilityA)',validLaunch)
mutate('issue_capability_before_claim',o,'const armed = await fin4ClaimLaunchForArmedRun(runId)\n    const capabilityA','const capabilityA',validLaunch)
mutate('log_capability',o,'const origin = exactDeploymentOrigin()','console.log(capabilityA)\n    const origin = exactDeploymentOrigin()',validLaunch)
mutate('preflight_claims_launch',o,'const present = fin4AutomationBypassPresent()','const present = fin4AutomationBypassPresent()\n  await fin4ClaimLaunchForArmedRun(runId)',validPreflight)

// R4F evidence-probe mutations.
mutate('evidence_probe_skips_durable_identity',o,'getDurableU2AIngressAuthoritative(paymentId)','({ outcome: "FOUND", checkpoint: {} } as any)',validEvidence)
mutate('evidence_probe_skips_production_evaluator',o,'evaluateFinancialRecoveryPiCandidates({','evaluateFinancialRecoveryPiCandidates_DISABLED({',validEvidence)

// Role mutations.
mutate('role_a_skips_capability_validation',ra,'const capability = fin4ValidateInvocationCapability(request.headers.get("x-flashpay-fin4-capability"), runId, "A", paymentId)','const capability = {} as any',s=>validRole(s,'A'))
mutate('role_b_skips_capability_validation',rb,'const capability = fin4ValidateInvocationCapability(request.headers.get("x-flashpay-fin4-capability"), runId, "B", paymentId)','const capability = {} as any',s=>validRole(s,'B'))
mutate('role_a_skips_capability_consume',ra,'await fin4ConsumeInvocationCapability(capability)','void capability',s=>validRole(s,'A'))
mutate('role_b_skips_capability_context',rb,'return await fin4RunWithInvocationCapability(capability, async () => {','return await (async () => {',s=>validRole(s,'B'))
mutate('allow_role_a_client_payment',ra,'fin4ArmedPaymentForRole(runId, "A")','(await request.json()).paymentId',s=>validRole(s,'A'))
mutate('allow_role_b_client_payment',rb,'fin4ArmedPaymentForRole(runId, "B")','(await request.json()).paymentId',s=>validRole(s,'B'))

// Previously closed timestamp-drift regressions.
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

if(!validHarness(h)||!validIntegration(a)||!validLaunch(o)||!validPreflight(o)||!validEvidence(o)||!validRole(ra,'A')||!validRole(rb,'B')||!validComplete(c)||!validRepair(l))throw new Error('original FIN4 R4E invalid')
console.log(`FIN4_LIVE_R4F_MUTATIONS=PASS expected_failures=${expected} unexpected_passes=0`)
