const fs = require('node:fs')
const assert = require('node:assert')
const probe = fs.readFileSync('lib/fin4-r4q-stage1-failure-evidence.ts','utf8')
const route = fs.readFileSync('app/api/certification/fin4-trigger/route.ts','utf8')
const checks = [
  ['probe server-only', probe.includes('import "server-only"')],
  ['reads settlement checkpoints', probe.includes('FROM settlement_checkpoints WHERE payment_id IN ($1,$2)')],
  ['reads ongoing observations', probe.includes('FROM settlement_a2u_ongoing_observations WHERE payment_id=$1')],
  ['reads redis only', probe.includes('redis.get(`payment:${paymentA}`)') && !probe.includes('redis.set(') && !probe.includes('redis.eval(')],
  ['uses Pi reconciliation read', probe.includes('reconcileIncompleteA2UPayment(paymentA,amount,merchantUid)')],
  ['exposes failure code', probe.includes('a2uErrorCode:s(p.a2uErrorCode)')],
  ['exposes retry state', probe.includes('settlementFailureState:s(p.settlementFailureState)') && probe.includes('nextRetryAt:s(p.nextRetryAt)')],
  ['no Pi POST', !probe.includes('method: "POST"') && !probe.includes("method:'POST'")],
  ['no Horizon submit', !probe.includes('.submitTransaction(')],
  ['declares no mutations', probe.includes('financialAuthorityMutated:false') && probe.includes('piMutationExecuted:false') && probe.includes('horizonSubmitExecuted:false') && probe.includes('redisMutated:false')],
  ['route wired', route.includes('evidence") === "r4q-stage1-failure"') && route.includes('readFin4R4QStage1FailureEvidence(paymentA, paymentB)')],
]
for (const [name, ok] of checks) assert.ok(ok, `R4Q check failed: ${name}`)
console.log(`FIN4_R4Q_READ_ONLY_STAGE1_FAILURE_EVIDENCE=PASS checks=${checks.length}`)
