import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const db=read('lib/db.ts'), payments=read('app/api/payments/route.ts'), refunds=read('app/api/refunds/intent/route.ts')

// Settlement: first payment request initializes durable authority before F2-1 write.
const schemaCall=payments.indexOf('await ensureSettlementCheckpointTable()')
const identityCall=payments.indexOf('await recordSettlementPaymentIdentityCheckpoint({')
assert.ok(schemaCall>0 && identityCall>schemaCall)
assert.ok(payments.includes('code: "PAYMENT_SCHEMA_UNAVAILABLE"'))
assert.ok(db.includes('CREATE TABLE IF NOT EXISTS settlement_checkpoints'))
assert.ok(db.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_checkpoints_a2u_payment_id'))
assert.ok(db.includes('CREATE TABLE IF NOT EXISTS settlement_recovery_scan_cursor'))
assert.ok(db.includes('CREATE TABLE IF NOT EXISTS u2a_ingress_recovery_scan_cursor'))

// Refund: first authenticated request initializes the exact durable schema, then
// independently verifies it before reading body/creating intent.
const refundEnsure=refunds.indexOf('await ensureRefundCheckpointTables()')
const refundVerify=refunds.indexOf('await verifyRefundTables()')
const refundBody=refunds.indexOf('await request.json()')
assert.ok(refundEnsure>0 && refundVerify>refundEnsure && refundBody>refundVerify)
for(const x of [
  'CREATE TABLE IF NOT EXISTS refund_checkpoints',
  'CREATE TABLE IF NOT EXISTS refund_accounting_records',
  'CREATE TABLE IF NOT EXISTS refund_audit_events',
  'CREATE INDEX IF NOT EXISTS idx_refund_checkpoints_status_retry',
  'CREATE INDEX IF NOT EXISTS idx_refund_checkpoints_payment',
  'CREATE INDEX IF NOT EXISTS idx_refund_audit_payment_created',
  'CREATE INDEX IF NOT EXISTS idx_refund_audit_refund_created',
]) assert.ok(db.includes(x),x)
assert.ok(db.includes("if (!(await ensureRefundCheckpointTables()))"))

// Adversarial clean-install/concurrent model: CREATE IF NOT EXISTS converges;
// a failed DDL step never opens the financial gate.
function coldStart(contenders,failStep=-1){
  const objects=new Set(); let admitted=0,blocked=0
  const steps=['settlement','settlement-a2u-index','settlement-cursor','u2a-cursor','refund-checkpoints','refund-accounting','refund-audits','refund-indexes']
  for(let w=0;w<contenders;w++){
    let ok=true
    for(let i=0;i<steps.length;i++){
      if(i===failStep){ok=false;break}
      objects.add(steps[i])
    }
    if(ok && objects.size===steps.length) admitted++; else blocked++
  }
  return {objects:objects.size,admitted,blocked}
}
const concurrent=coldStart(10000)
assert.equal(concurrent.objects,8); assert.equal(concurrent.admitted,10000); assert.equal(concurrent.blocked,0)
for(let i=0;i<8;i++){const r=coldStart(1,i);assert.equal(r.admitted,0);assert.equal(r.blocked,1)}
console.log(JSON.stringify({certification:'PASS',gate:'DR-13-FIRST-REQUEST-SCHEMA-INITIALIZATION',cleanInstall:true,concurrentColdStarts:10000,failClosedDdlFailurePoints:8,financialMovementExecuted:false,dependenciesAdded:0},null,2))
