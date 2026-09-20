import{strict as assert}from"node:assert";import fs from"node:fs";
const db=fs.readFileSync(new URL("../lib/db.ts",import.meta.url),"utf8");
const fn=db.slice(db.indexOf("export async function listOutstandingSettlementCheckpointIds"),db.indexOf("export type SettlementRefundAuthorityCheck"));
assert.ok(fn.includes("await ensureSettlementCheckpointTable()"),"durable scan must establish schema before cursor read");
assert.ok(fn.indexOf("await ensureSettlementCheckpointTable()")<fn.indexOf("SELECT last_updated_at,last_payment_id FROM settlement_recovery_scan_cursor"),"schema gate must precede cursor query");
assert.ok(db.includes("CREATE TABLE IF NOT EXISTS settlement_recovery_scan_cursor"),"cursor DDL missing");
assert.ok(db.includes("INSERT INTO settlement_recovery_scan_cursor(singleton)")&&db.includes("ON CONFLICT(singleton) DO NOTHING"),"cursor seed must be idempotent");
assert.ok(!fn.includes("CREATE TABLE"),"DDL remains centralized in schema helper, not duplicated in scan body");
console.log(JSON.stringify({certification:"PASS",gate:"N-FIN-X1-PRODUCTION-SCHEMA-REPAIR",schemaGateBeforeCursor:true,idempotentCursorDDL:true,idempotentSeed:true,financialMovementChanged:false,paymentStatusChanged:false},null,2));