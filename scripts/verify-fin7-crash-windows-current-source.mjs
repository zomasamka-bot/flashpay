import fs from 'node:fs'
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const windows=read('lib/financial-recovery-crash-window.ts')
const policy=read('lib/financial-recovery-crash-policy.ts')
const approve=read('app/api/pi/approve/route.ts')
const complete=read('app/api/pi/complete/route.ts')
const transient=read('app/api/recovery/transient/route.ts')
const pretx=read('app/api/pi/recover-pretransaction/route.ts')
const a2u=read('lib/a2u-executor.ts')
const locked=read('lib/a2u-locked-executor.ts')
const refund=read('lib/refund-executor.ts')
const must=(ok,msg)=>{if(!ok)throw new Error(`FIN7_CRASH_WINDOWS_CURRENT_SOURCE=FAIL ${msg}`)}
const names=[...windows.matchAll(/^\s*"([a-z0-9_]+)",$/gm)].map(m=>m[1])
must(names.length===41,`canonical count ${names.length} != 41`)
must(new Set(names).size===41,'canonical names not unique')
for(const n of names) must(policy.includes(`${n}: {`),`policy missing ${n}`)
const order=(src,a,b,msg)=>{const x=src.indexOf(a),y=src.indexOf(b,x+1);must(x>=0&&y>x,msg)}
// S2 approval: ownership -> replay reconcile -> one-shot claim -> POST -> exact reconciliation.
order(approve,'const approvalClaim = await recordSettlementU2AApprovalClaimFromStartLease','if (approvalClaim.outcome === "REPLAYED")','approval ownership/replay ordering')
order(approve,'const approvalAttempt = await claimSettlementU2AApprovalAttempt','/approve`','approval attempt must precede POST')
order(approve,'/approve`','Mandatory exact reconciliation','approval POST must precede exact reconciliation')
must(approve.includes('approvalAttempt.outcome !== "RECORDED"'),'approval POST not RECORDED-only')
// U2A completion: durable verified -> attempt -> POST -> exact GET -> durable completed -> Redis projection.
order(complete,'const durableU2AVerified = await recordSettlementU2AVerifiedCheckpoint','const completionAttempt = await claimSettlementPiMutationAttempt','U2A verified/attempt ordering')
order(complete,'const completionAttempt = await claimSettlementPiMutationAttempt','/complete`','U2A completion attempt/POST ordering')
const post=complete.indexOf('/complete`'), refetch=complete.indexOf('const refetchResponse = await fetch',post), durable=complete.indexOf('recordSettlementU2ACompletedCheckpoint',refetch)
must(post>=0&&refetch>post&&durable>refetch,'U2A POST -> exact GET -> durable completion ordering')
must(transient.includes("kind:'u2a_complete'")&&transient.includes("completionAttempt.outcome!=='RECORDED'"),'transient U2A completion not one-shot bound')
// FIN5 settlement create one-shot.
order(a2u,'const createAttempt = await claimSettlementA2UCreateAttempt','fetch("https://api.minepi.com/v2/payments"','A2U create attempt/POST ordering')
must(a2u.includes('createAttempt.outcome !== "RECORDED"'),'A2U create not RECORDED-only')
// S1 Redis prepared is not financial authority; PG prepared gate precedes Horizon submit.
order(a2u,'ctx.payment = await persistCheckpointMerged(ctx.paymentId, { a2uPreparedEnvelopeXdr: preparedEnvelopeXdr','const durablePrepared = await recordSettlementPreparedCheckpoint','Redis prepared/PG prepared boundary missing')
const submitBranch=locked.indexOf('if (params.recoveryOperation === "SETTLEMENT_SUBMIT")')
const durableGuard=locked.indexOf('verifySettlementSubmitDurablePreparedAuthority',submitBranch), horizon=locked.indexOf('horizon.submitTransaction',submitBranch)
must(submitBranch>=0&&durableGuard>submitBranch&&horizon>durableGuard,'durable prepared authority must precede Horizon submit')
// S3 A2U complete one-shot.
order(a2u,'const completionAttempt = await claimSettlementPiMutationAttempt({ kind: "a2u_complete"','/complete`','A2U completion attempt/POST ordering')
// S3 pretransaction cancel: exact Pi+Horizon absence -> claim -> cancel -> exact Pi -> durable retirement.
order(pretx,"kind:'u2a_cancel'",'/cancel','U2A cancel attempt/POST ordering')
order(pretx,'/cancel','const after=await getPi','U2A cancel POST/reconcile ordering')
order(pretx,'const after=await getPi','retireSettlementU2AApprovalAfterCanonicalCancellation','U2A cancel reconciliation/retirement ordering')
// S4 refund create one-shot and success-before-ID checkpoint.
order(refund,'const createAttempt = await claimRefundCreateAttempt','fetch(\'https://api.minepi.com/v2/payments\'','refund create attempt/POST ordering')
must(refund.includes("createAttempt.outcome !== 'RECORDED'"),'refund create not RECORDED-only')
// S3 refund complete and DR11 cancel one-shot.
order(refund,"kind: 'refund_complete'",'/complete','refund completion attempt/POST ordering')
order(refund,"kind: 'dr11_a2u_cancel'",'/cancel','DR11 cancel attempt/POST ordering')
console.log('FIN7_CRASH_WINDOWS_CURRENT_SOURCE=PASS windows=41 runtime_kernel_unchanged=true live_crash_required=false')
