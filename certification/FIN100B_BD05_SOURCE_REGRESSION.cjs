'use strict';
// Non-mutating source regression: intentionally fails while B-D05 defects remain.
const fs=require('node:fs'); const assert=require('node:assert/strict'); const path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../app/api/payments/route.ts'),'utf8');
const post=source.slice(source.indexOf('export async function POST('),source.indexOf('// GET /api/payments'));
const get=source.slice(source.indexOf('export async function GET('));
const cases=[
 {name:'B-D05-R1: existing createIntentId recovery cannot be blocked by new-creation rate limit',pass:(()=>{const limit=post.indexOf('await consumeFinancialRateLimit(');const durable=post.indexOf('await recordPaymentCreateIntentAtomic(');return limit>=0&&durable>=0&&durable<limit})(),evidence:'POST currently consumes payments-create limiter before durable identity lookup'},
 {name:'B-D05-R2: Redis cache miss cannot be treated as authoritative payment nonexistence',pass:(()=>{const miss=get.indexOf('if (!payment)');const notfound=get.indexOf('status: 404',miss);return miss>=0&&notfound>=0&&/durable|checkpoint|readPayment/i.test(get.slice(miss,notfound))})(),evidence:'GET currently returns 404 on Redis miss without durable-state check'},
];
let failures=0; for(const t of cases){console.log(`${t.pass?'PASS':'FAIL'} | ${t.name}`);if(!t.pass){console.log(`  EVIDENCE: ${t.evidence}`);failures++}}
console.log(`B_D05_SOURCE_REGRESSION=${cases.length-failures}/${cases.length} PASS`);
if(failures)process.exitCode=1;
