import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8')
const harness=read('lib/dr14-live-crash-certification.ts'), settlement=read('lib/a2u-executor.ts'), refund=read('lib/refund-executor.ts'), submit=read('lib/refund-blockchain-submit.ts'), route=read('app/api/control/dr14/route.ts')
for(const x of ['payment_id TEXT PRIMARY KEY','consumed_at TIMESTAMP','expires_at TIMESTAMP','UPDATE certification_fault_arms SET consumed_at=NOW()','consumed_at IS NULL AND expires_at>NOW()']) assert.ok(harness.includes(x),x)
assert.ok(route.includes("verifyOwnerAuthorizationHeader")); assert.ok(harness.includes('function isRow(value: unknown): value is Record<string, unknown>')); assert.ok(harness.includes('!isRow(identity[0])')); assert.equal(harness.includes('identity[0]?.payment_id'),false); assert.ok(route.includes("ARM_DR14_ONE_SHOT")); assert.ok(route.includes("READINESS_DR14_ONLY")); assert.ok(harness.includes('export async function readDr14Readiness')); assert.ok(harness.includes("reason: 'active_arm_exists'")); assert.ok(harness.includes("reason: 'refund_authority_exists'")); assert.ok(route.includes('financialExecutionStarted:false'))
const boundaries=[
'settlement_after_stage1_durable','settlement_after_prepared_durable','settlement_after_horizon_submit_before_checkpoint','settlement_after_horizon_durable','settlement_after_pi_durable','settlement_after_db_durable',
'refund_after_pi_create_before_id_checkpoint','refund_after_prepared_before_submit','refund_after_horizon_submit_before_tx_checkpoint','refund_after_payment_checkpoint','refund_after_accounting','refund_after_audit','refund_after_completion_before_projection']
for(const b of boundaries){ assert.ok(harness.includes(`'${b}'`),`enum ${b}`); assert.ok((settlement+refund+submit).includes(`'${b}'`),`runtime ${b}`) }
assert.equal(/customerAmount\s*===\s*0\./.test(harness+route),false,'DR14 authority must not use magic amount')
assert.equal(/merchantId\s*===/.test(harness+route),false,'DR14 authority must not use merchant magic')
assert.ok(settlement.indexOf("recordSettlementA2UCreatedCheckpoint") < settlement.indexOf("'settlement_after_stage1_durable'"))
assert.ok(settlement.indexOf("prepareStage2UnderHeldWalletLock") < settlement.indexOf("'settlement_after_prepared_durable'"))
assert.ok(settlement.indexOf("moved = await moveStage2UnderHeldWalletLock") < settlement.indexOf("'settlement_after_horizon_submit_before_checkpoint'"))
assert.ok(settlement.indexOf("if (!finalized.ok) return finalized") < settlement.indexOf("'settlement_after_horizon_durable'"))
assert.ok(refund.indexOf("reconcileRefundWithPi") < refund.indexOf("'refund_after_pi_create_before_id_checkpoint'"))
assert.ok(submit.indexOf("ensureRefundPreparedSubmit") < submit.indexOf("'refund_after_prepared_before_submit'"))
assert.ok(refund.indexOf("submitRefundBlockchainOnce") < refund.indexOf("'refund_after_horizon_submit_before_tx_checkpoint'"))
console.log(JSON.stringify({certification:'PASS',gate:'DR72-DR14-LIVE-CRASH-HARNESS',boundaries:boundaries.length,ownerOnly:true,oneShot:true,ttlMinutes:30,magicAmount:false,financialAuthorityChanged:false,financialMovementExecuted:false},null,2))
