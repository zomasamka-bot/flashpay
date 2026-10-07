import fs from 'node:fs'
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const db=read('lib/db.ts'), refunds=read('lib/refund-checkpoint-store.ts'), pretx=read('app/api/pi/recover-pretransaction/route.ts')
const complete=read('app/api/pi/complete/route.ts'), transient=read('app/api/recovery/transient/route.ts'), a2u=read('lib/a2u-executor.ts'), rex=read('lib/refund-executor.ts')
const must=(ok,msg)=>{if(!ok)throw new Error(`FIN7 mutation authority verifier failed: ${msg}`)}
must(db.includes("pi_mutation_guard_version TEXT")&&db.includes("'fin7_v2'"),'settlement generation guard missing')
must(db.includes('CREATE TABLE IF NOT EXISTS financial_pi_mutation_attempts'),'append-only mutation attempt table missing')
must(db.includes("kind: 'u2a_cancel' | 'u2a_complete' | 'a2u_complete'"),'settlement mutation kinds missing')
must(db.includes("if(r.pi_mutation_guard_version!=='fin7_v2')"),'legacy settlement fail-closed guard missing')
must(db.includes("if(inserted.length===1){")&&db.includes("outcome:'RECORDED'"),'settlement RECORDED-only claim missing')
must(refunds.includes("pi_mutation_guard_version)")&&refunds.includes("'fin7_v2'"),'refund generation guard missing')
must(refunds.includes("kind: 'dr11_a2u_cancel' | 'refund_complete'"),'refund mutation kinds missing')
must(refunds.includes("if(r.pi_mutation_guard_version!=='fin7_v2')"),'legacy refund fail-closed guard missing')
const bindings=[
  [pretx,"kind:'u2a_cancel'",'/cancel'],[complete,'kind: "u2a_complete"','/complete'],[transient,"kind:'u2a_complete'",'/complete'],
  [a2u,'kind: "a2u_complete"','/complete'],[rex,"kind: 'dr11_a2u_cancel'",'/cancel'],[rex,"kind: 'refund_complete'",'/complete'],
]
for(const [src,claim,endpoint] of bindings){const c=src.indexOf(claim),p=src.indexOf(endpoint,c);must(c>=0&&p>c,`${claim} must precede ${endpoint}`)}
must(pretx.includes("attempt.outcome!=='RECORDED'"),'pretransaction cancel is not RECORDED-only')
must(complete.includes('completionAttempt.outcome !== "RECORDED"'),'primary U2A complete is not RECORDED-only')
must(transient.includes("completionAttempt.outcome!=='RECORDED'"),'transient U2A complete is not RECORDED-only')
must(a2u.includes('completionAttempt.outcome !== "RECORDED"'),'A2U complete is not RECORDED-only')
must(rex.includes("cancelAttempt.outcome !== 'RECORDED'")&&rex.includes("completionAttempt.outcome !== 'RECORDED'"),'refund mutations are not RECORDED-only')
must(a2u.indexOf('if (await refetchCompleted()) return { ok: true }') < a2u.indexOf('kind: "a2u_complete"'),'A2U complete must reconcile before claim')
console.log('FIN7_PI_MUTATION_ONE_SHOT_AUTHORITY=PASS guard=fin7_v2 legacy=fail_closed post=recorded_only mutations=6')
