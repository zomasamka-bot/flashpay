'use strict';
// Test-only. Requires verified isolated network and disposable DB. NO production credentials.
const crypto = require('node:crypto');
const postgres = require('postgres');
const {Redis} = require('@upstash/redis');
const endpoint = 'http://flashpay-bd05-http-next-test:3001/api/payments';
if(process.env.BD05_ISOLATED_TEST!=='YES' || process.env.BD05_DB_HOST!=='bd05-postgres' || process.env.BD05_DB_NAME!=='bd05_http_test' || process.env.BD05_REDIS_URL!=='http://flashpay-bd05-http-bridge:56381') throw Error('BD05 safety refusal');
const pg=postgres({host:process.env.BD05_DB_HOST,database:process.env.BD05_DB_NAME,username:'bd05_admin',password:process.env.BD05_DB_PASS,connect_timeout:5});
const redis=new Redis({url:process.env.BD05_REDIS_URL,token:process.env.BD05_BRIDGE_TOKEN});
const results=[];
const runId=crypto.randomUUID().slice(0,8);
const make=(id,amount=1,note='BD05-'+runId,accessToken='BD05_TOKEN_MERCHANT_A')=>({amount,note,accessToken,createIntentId:id});
async function call(body){const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});let x;try{x=await r.json()}catch{x={}}return {status:r.status,...x}}
function assert(name,condition,info=''){results.push({name,result:condition?'PASS':'FAIL',info});console.log(name+'='+(condition?'PASS':'FAIL')+(info?' '+info:''));}
async function main(){
 const identity=await pg`select current_database() as db, current_user as usr`;
 if(identity[0]?.db!=='bd05_http_test'||identity[0]?.usr!=='bd05_admin')throw Error('DB identity mismatch');
 const before=await pg`select count(*)::int as n from payment_create_intents`;
 console.log('BD05_DB_IDENTITY=PASS RUN='+runId+' BEFORE='+before[0].n);
 const id=crypto.randomUUID();
 const first=await call(make(id));assert('CREATE_FIRST_201',first.status===201&&first.payment?.id&&first.payment.status==='pending','HTTP='+first.status+' CODE='+(first.code||'-'));
 if(!first.payment?.id){console.log('BD05_STOP_NO_DURABLE_PAYMENT');process.exitCode=1;return;}
 const paymentId=first.payment.id;
 const replay=await call(make(id));assert('REPLAY_SAME_ID_200',replay.status===200&&replay.payment?.id===paymentId,'HTTP='+replay.status+' CODE='+(replay.code||'-'));
 const conflict=await call(make(id,2));assert('CONFLICT_409',conflict.status===409&&conflict.code==='CREATE_INTENT_CONFLICT','HTTP='+conflict.status+' CODE='+(conflict.code||'-'));
 const second=await call(make(crypto.randomUUID()));assert('DISTINCT_INTENT_NEW_ID',second.status===201&&!!second.payment?.id&&second.payment.id!==paymentId,'HTTP='+second.status);
 const durable=await pg`select payment_id,merchant_uid from payment_create_intents where create_intent_id=${id}`;
 assert('DURABLE_SINGLE_ROW',durable.length===1&&durable[0].payment_id===paymentId,'ROWS='+durable.length);
 const redisPayment=await redis.get('payment:'+paymentId);
 assert('REDIS_PROJECTION_MATCH',!!redisPayment&&redisPayment.id===paymentId&&redisPayment.status==='pending');
 const after=await pg`select count(*)::int as n from payment_create_intents`;
 console.log('BD05_BEFORE='+before[0].n+' AFTER='+after[0].n);
 const n=results.filter(r=>r.result==='PASS').length;
 console.log('BD05_BEHAVIORAL_SMOKE='+n+'/'+results.length+(n===results.length?' PASS':' FAIL'));
 console.log('NOTE=NOT_R41_10_OF_10; NO_PI_HORIZON_REAL_CALLS; PRODUCTION_NOT_FOR_DEPLOY');
 if(n!==results.length)process.exitCode=1;
}
main().catch(e=>{console.log('BD05_BEHAVIORAL_SMOKE=FAIL ERROR='+(e.code||e.message));process.exitCode=1}).finally(async()=>{await pg.end({timeout:2}).catch(()=>{})});
