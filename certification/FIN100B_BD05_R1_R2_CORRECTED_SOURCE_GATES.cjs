'use strict';
// Source-only structural assertions; NOT behavioral or financial certification.
const fs=require('node:fs'), path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const route=fs.readFileSync(path.join(root,'app/api/payments/route.ts'),'utf8');
const db=fs.readFileSync(path.join(root,'lib/db.ts'),'utf8');
const post=route.split('export async function POST(')[1]?.split('// GET /api/payments?id=')[0]||'';
const get=route.split('export async function GET(')[1]||'';
const positions=[post.indexOf('await ensurePaymentCreateIntentTable()'),post.indexOf('await classifyPaymentCreateIntentReplay('),post.indexOf('await consumeFinancialRateLimit('),post.indexOf('await recordPaymentCreateIntentAtomic(')];
const r1=positions.every(x=>x>=0)&&positions.every((x,i)=>i===0||positions[i-1]<x)&&post.includes('if (replayClassification === "NEW")')&&post.includes('replayClassification === "INDETERMINATE"');
const r2=get.includes('await probeDurablePaymentIdentity(id)')&&get.includes("durable !== 'ABSENT'")&&get.includes('status: 404')&&db.includes('FROM payment_create_intents WHERE payment_id = ${paymentId}')&&db.includes('FROM settlement_checkpoints WHERE payment_id = ${paymentId}')&&db.includes('FROM transactions WHERE payment_id = ${paymentId}');
console.log('ROUTE_SHA256='+crypto.createHash('sha256').update(route).digest('hex'));
console.log('R1_STRUCTURAL='+(r1?'PASS':'FAIL'));
console.log('R2_STRUCTURAL='+(r2?'PASS':'FAIL'));
console.log('SOURCE_ONLY=TRUE; BEHAVIORAL_CERTIFICATION=NOT_RUN');
if(!r1||!r2)process.exitCode=1;
