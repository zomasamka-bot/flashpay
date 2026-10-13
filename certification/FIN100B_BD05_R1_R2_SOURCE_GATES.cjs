'use strict';
// Read-only source-order regression gates; NOT a behavioral or financial certification.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const file=path.join(root,'app/api/payments/route.ts');
const source=fs.readFileSync(file,'utf8');
const hash=crypto.createHash('sha256').update(source).digest('hex');
function section(from,to){const a=source.indexOf(from);const b=source.indexOf(to,a+from.length);if(a<0||b<0)throw Error('Source boundaries changed');return source.slice(a,b)}
const post=section('export async function POST(', '// GET /api/payments?id=');
const get=source.slice(source.indexOf('export async function GET('));
const limiter=post.indexOf('await consumeFinancialRateLimit(');
const durable=post.indexOf('await recordPaymentCreateIntentAtomic(');
const replay=post.indexOf('durableIdentity.outcome === "REPLAYED"');
const redisGet=get.indexOf('await redis.get(`payment:${id}`)');
const notFound=get.indexOf('if (!payment)');
const failR1=limiter>=0&&durable>=0&&replay>=0&&limiter<durable&&durable<replay;
const failR2=redisGet>=0&&notFound>redisGet&&!/payment_create_intents|settlement_checkpoints|durable|Postgres|checkpoint/i.test(get.slice(redisGet,notFound+130));
console.log('ROUTE_SHA256='+hash);
console.log('R1_LIMITER_BEFORE_DURABLE_REPLAY='+(failR1?'FAIL':'REVIEW_REQUIRED'));
console.log('R2_REDIS_MISS_NO_DURABLE_LOOKUP='+(failR2?'FAIL':'REVIEW_REQUIRED'));
console.log('SOURCE_ONLY=TRUE; NO_DB_REDIS_PI_HORIZON_REQUESTS');
process.exitCode=(failR1||failR2)?1:0;
