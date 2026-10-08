import { readFileSync } from 'node:fs'
const read=(p)=>readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const helper=read('lib/fin8-live-ambiguity-certification.ts')
const approve=read('app/api/pi/approve/route.ts')
const complete=read('app/api/pi/complete/route.ts')
const transient=read('app/api/recovery/transient/route.ts')
const dr11=complete
const must=(ok,msg)=>{if(!ok)throw new Error(`FIN8 LIVE ambiguity hook verifier failed: ${msg}`)}

must(helper.includes('process.env.VERCEL_ENV === "production"'),'hook is not production-gated')
must(helper.includes('process.env.FLASHPAY_FIN8_LIVE_PAYMENT_ID'),'exact fixture identity gate missing')
must(helper.includes('input.paymentId === armedPaymentId'),'fixture identity is not exact')
must(helper.includes('input.network === "Pi Testnet"'),'Pi Testnet gate missing')
must(helper.includes('input.amount === 0.2'),'exact 0.20 Pi gate missing')
must(!helper.includes('input.amount === 0.1'),'FIN8 must not reuse DR11 0.10 Pi scope')

const aClaim=approve.indexOf('const approvalAttempt = await claimSettlementU2AApprovalAttempt')
const aPost=approve.indexOf('`https://api.minepi.com/v2/payments/${identifier}/approve`',aClaim)
const aHook=approve.indexOf('stage: "approve_post_response_lost"',aPost)
const aConsume=approve.indexOf('const approvalData = await approvalResponse.json()',aPost)
const aReconcile=approve.indexOf('Refetching Pi payment to verify developer_approved',aPost)
must(aClaim>=0&&aPost>aClaim&&aHook>aPost&&aConsume>aHook&&aReconcile>aConsume,'approve ordering must be durable claim -> POST -> FIN8 loss -> response consume -> GET reconcile')
must(approve.includes('if (approvalClaim.outcome === "REPLAYED")'),'approve replay reconcile-first branch missing')
must(approve.indexOf('if (approvalClaim.outcome === "REPLAYED")') < aClaim,'approve replay must reconcile before attempt claim')

const cVerified=complete.indexOf('const durableU2AVerified = await recordSettlementU2AVerifiedCheckpoint')
const cClaim=complete.indexOf('const completionAttempt = await claimSettlementPiMutationAttempt',cVerified)
const cPost=complete.indexOf('`https://api.minepi.com/v2/payments/${piPaymentId}/complete`',cClaim)
const cHook=complete.indexOf('stage: "complete_post_response_lost"',cPost)
const cConsume=complete.indexOf('if (!completeResponse.ok)',cPost)
const cReconcile=complete.indexOf('const refetchResponse = await fetch',cPost)
const cDurable=complete.indexOf('const durableU2ACompleted = await recordSettlementU2ACompletedCheckpoint',cPost)
must(cVerified>=0&&cClaim>cVerified&&cPost>cClaim&&cHook>cPost&&cConsume>cHook&&cReconcile>cConsume&&cDurable>cReconcile,'complete ordering must be verified -> claim -> POST -> FIN8 loss -> response consume -> GET -> durable completed')

const tGet=transient.indexOf('let pi=await readExactPiU2A()')
const tDone=transient.indexOf("if(pi.status.developer_completed!==true)",tGet)
const tClaim=transient.indexOf("kind:'u2a_complete'",tDone)
const tPost=transient.indexOf('/complete',tClaim)
must(tGet>=0&&tDone>tGet&&tClaim>tDone&&tPost>tClaim,'transient recovery must GET Pi before shared u2a_complete claim/POST')
must(transient.includes("completionAttempt.outcome!=='RECORDED'"),'transient recovery must refuse replayed mutation authority')

must(dr11.includes('finalPiPayment.amount === 0.1'),'DR11 permanent 0.10 Pi refund certification hook was removed or changed')
must(dr11.includes('recordDr11RefundCertificationHold'),'DR11 refund authority hold missing')

console.log('FIN8_LIVE_APPROVE_COMPLETE_AMBIGUITY_HOOK=PASS scope=production+Pi_Testnet+0.20+exact_payment_id approve=post_response_loss complete=post_response_loss recovery=reconcile_first DR11_0.10=preserved')
