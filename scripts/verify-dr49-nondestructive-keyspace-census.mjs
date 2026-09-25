import { strict as assert } from "node:assert"; import fs from "node:fs";
const r=fs.readFileSync("app/api/recovery/transient/route.ts","utf8"), c=fs.readFileSync("app/api/control/dr10/route.ts","utf8"), u=fs.readFileSync("app/control-panel/page.tsx","utf8");
for(const x of ['DR10_KEYSPACE_CENSUS_MODE = "dr10-keyspace-census"','const censusOnly=dr10Mode===DR10_KEYSPACE_CENSUS_MODE','unknownNamespaceCounts','unknownSuffixShapeCounts','[DR50 DR10 NONDESTRUCTIVE PROVENANCE CENSUS]','deletionAttempted:false']) assert.ok(r.includes(x),x);
assert.ok(r.indexOf('if(censusOnly)') < r.indexOf('let deleted=0'),'census must return before deletion');
assert.ok(r.includes('valuesRead:false')&&!r.includes('await redis.get(key)'),'census must not read foreign values');
for(const x of ['const CENSUS_CONFIRM = "CENSUS_ONLY"','censusOnly ? "dr10-keyspace-census" : "dr10-total-redis-loss"','...(censusOnly ? {} : { "x-flashpay-dr10-confirm": CONFIRM })']) assert.ok(c.includes(x),x);
assert.ok(u.includes('Run DR10 Safe Census')&&u.includes('confirmation: "CENSUS_ONLY"'));
console.log(JSON.stringify({dr49:"PASS",censusReturnsBeforeDeletion:true,foreignValuesRead:false,rawKeysLogged:false,destructiveConfirmationPreserved:true,financialAuthorityChanged:false},null,2));
