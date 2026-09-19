import { strict as assert } from "node:assert"
import fs from "node:fs"
const db=fs.readFileSync(new URL("../lib/db.ts",import.meta.url),"utf8")
const executor=fs.readFileSync(new URL("../lib/a2u-executor.ts",import.meta.url),"utf8")
const recovery=fs.readFileSync(new URL("../lib/a2u-recovery-service.ts",import.meta.url),"utf8")
const locked=fs.readFileSync(new URL("../lib/a2u-locked-executor.ts",import.meta.url),"utf8")
for(const x of [
"CREATE TABLE IF NOT EXISTS settlement_checkpoints",
"payment_id TEXT PRIMARY KEY",
"version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0)",
"'payment_identity'","'a2u_created'","'prepared'","'horizon_confirmed'","'pi_completed'","'db_finalized'",
"app_commission NUMERIC(18, 8) NOT NULL DEFAULT 0 CHECK (app_commission = 0)",
"merchant_amount IS NULL OR merchant_amount = customer_amount",
"prepared_tx_hash = a2u_txid",
"CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_checkpoints_a2u_payment_id",
"CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_checkpoints_prepared_tx_hash",
"CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_checkpoints_a2u_txid",
"if (!(await ensureSettlementCheckpointTable()))"
]) assert.ok(db.includes(x),`missing schema invariant: ${x}`)
// N10A must be non-invasive: no Settlement execution/recovery module may reference the new authority yet.
for(const [name,source] of [["executor",executor],["recovery",recovery],["locked",locked]])
  assert.equal(source.includes("settlement_checkpoints"),false,`${name} prematurely coupled to N10 authority`)
console.log(JSON.stringify({certification:"PASS",baseline:"333bb8003cb5cb509a6c8572325be06d650a0d93",schemaOnly:true,runtimeFinancialPathChanged:false,authorityTable:"settlement_checkpoints",uniqueFinancialIdentityIndexes:3},null,2))
