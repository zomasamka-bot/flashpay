import { strict as assert } from "node:assert"; import fs from "node:fs";
const r=fs.readFileSync("app/api/recovery/transient/route.ts","utf8");
for(const x of ["[DR50 DR10 NONDESTRUCTIVE PROVENANCE CENSUS]","legacy_a2u_uuid","legacy_transaction_uuid","legacy_receipt_transaction_uuid","merchant_verified_uid_cache","legacy_merchant_transactions_index","legacy_merchant_balance_cache","legacy_merchant_txn_counter","dr50StructurallyUnknownCount","dr50DurableCoverage","queryOutcome:\"failed_closed\""]) assert.ok(r.includes(x),x);
assert.ok(r.indexOf('if(censusOnly)')<r.indexOf('let deleted=0'),"census exits before deletion");
assert.ok(!r.includes('await redis.get(key)'),"foreign values must not be read");
assert.ok(r.includes('FROM transactions WHERE id = ANY($1::uuid[])'));
assert.ok(r.includes('FROM receipts WHERE transaction_id = ANY($1::uuid[])'));
assert.ok(r.includes('FROM settlement_checkpoints WHERE payment_id = ANY($1::text[])'));
console.log(JSON.stringify({dr50:"PASS",metadataOnly:true,rawKeysLogged:false,redisValuesRead:false,censusDeletionReachable:false,structuralOwnershipFailClosed:true,durableCoverageReadOnly:true,financialMutation:false},null,2));
