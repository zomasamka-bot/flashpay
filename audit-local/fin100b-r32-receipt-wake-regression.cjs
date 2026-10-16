'use strict'
// Strictly isolated regression. No network, DB, Redis, Pi or Horizon access.
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
let ts
try { ts = require('typescript') } catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript') }
const read=p=>fs.readFileSync(p,'utf8')
const transpile=(p)=>ts.transpileModule(read(p),{fileName:p,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
function load(p, modules) {
  const exports={}
  vm.runInNewContext(transpile(p),{exports,require:name=>{
    if(!(name in modules))throw Error('UNEXPECTED_EXTERNAL_IMPORT '+name)
    return modules[name]
  },console:{error:()=>{},log:()=>{}},process,AbortController,Buffer,Date,Number,Map,Set,setTimeout,clearTimeout,URL},{filename:p,timeout:1500})
  return exports
}
const presentation=load('lib/receipt-presentation.ts',{})
const legacy=load('lib/legacy-receipt.ts',{'./receipt-presentation':presentation})
const UUID='ea20dddf-77be-4f0c-93f8-0f0b18c6e8da'
const row=()=>({transactionId:UUID, transactionMerchantId:'merchant-1',receiptMerchantId:'merchant-1',transactionMerchantUid:'uid-1',receiptMerchantUid:'uid-1',transactionPaymentId:'pi-payment-1',receiptU2aIdentifier:'pi-payment-1',transactionAmount:'1.20',receiptAmount:'1.20',customerAmount:'1.20',merchantAmount:'1.20',appCommission:'0',receiptCurrency:'π',receiptTimestamp:new Date('2026-01-02T03:04:05.000Z'),receiptSettlementStatus:'settled_to_merchant',transactionDescription:'a historical receipt',payerUsername:'customer-1'})
function bad(change){assert.equal(legacy.buildPostgresHistoricalReceipt({...row(),...change},'merchant-1'),null)}
let tests=0
function ok(msg,fn){fn();tests++;console.log('PASS '+msg)}
ok('historical_receipt_uses_db_transaction_id_not_flashpay_id',()=>{
 const r=legacy.buildPostgresHistoricalReceipt(row(),'merchant-1')
 assert.equal(r.receiptAuthority,'postgres_transaction');assert.equal(r.transactionId,UUID)
 assert.equal(r.status,'successful');assert.equal(r.receiptRecordedAt,'2026-01-02T03:04:05.000Z')
 assert.equal('flashPayPaymentId' in r,false);assert.equal('createdAt' in r,false)
})
ok('foreign_merchant_rejected',()=>bad({receiptMerchantId:'foreign'}))
ok('foreign_uid_rejected',()=>bad({receiptMerchantUid:'foreign'}))
ok('matching_legacy_empty_merchant_uids_supported',()=>{assert.ok(legacy.buildPostgresHistoricalReceipt({...row(),receiptMerchantUid:'',transactionMerchantUid:''},'merchant-1'))})
ok('receipt_amount_mismatch_rejected',()=>bad({receiptAmount:'1.30'}))
ok('customer_amount_mismatch_rejected',()=>bad({customerAmount:'1.30'}))
ok('nonzero_commission_rejected',()=>bad({appCommission:'0.01'}))
ok('u2a_identity_mismatch_rejected',()=>bad({receiptU2aIdentifier:'another-pi-id'}))
ok('missing_receipt_timestamp_rejected',()=>bad({receiptTimestamp:null}))
ok('invalid_currency_rejected',()=>bad({receiptCurrency:'USD'}))
ok('status_unknown_fails_to_needs_attention',()=>{assert.equal(legacy.buildPostgresHistoricalReceipt({...row(),receiptSettlementStatus:null},'merchant-1').status,'needs_attention')})
const JSONResponse={json:(body,opts={})=>({body,status:opts.status||200,headers:opts.headers})}
let queryRows=[row()],receiptPresent=true,receiptOwner='merchant-1'
const api=load('app/api/receipts/[id]/route.ts',{
 'next/server':{NextResponse:JSONResponse},'@/lib/db':{
  getReceipt:async()=>receiptPresent?{merchant_id:receiptOwner,u2a_identifier:'pi-payment-1'}:null,
  getReceiptByU2AIdentifier:async()=>null,query:async(_sql,params)=>{assert.equal(params[0],UUID);assert.equal(params[1],'merchant-1');return !receiptPresent || receiptOwner!=="merchant-1"?[]:queryRows}},
 '@/lib/legacy-receipt':legacy,
 '@/lib/merchant-auth':{authorizeFromHeader:async token=>token==='Bearer good'?{username:'merchant-1'}:null},
 '@/lib/redis':{isRedisConfigured:false,redis:{}},
 '@/lib/server-config':{serverConfig:{isPiApiKeyConfigured:false}},
 '@/lib/receipt-presentation':presentation,
})
const req=(token)=>({headers:{get:(x)=>x==='authorization'?token:null}})
const route=()=>({params:Promise.resolve({id:UUID})})
process.env.DATABASE_URL='synthetic-isolated-test-only'
async function run(){
 let res=await api.GET(req('Bearer good'),route())
 assert.equal(res.status,200);assert.equal(res.body.receiptAuthority,'postgres_transaction');assert.equal(res.body.transactionId,UUID);tests++;console.log('PASS authenticated_legacy_receipt_without_redis')
 res=await api.GET(req('Bearer bad'),route());assert.equal(res.status,401);tests++;console.log('PASS unauthenticated_receipt_denied')
 receiptPresent=false;res=await api.GET(req('Bearer good'),route());assert.equal(res.status,404);tests++;console.log('PASS missing_receipt_not_fabricated')
 receiptPresent=true;receiptOwner='foreign';res=await api.GET(req('Bearer good'),route());assert.equal(res.status,404);tests++;console.log('PASS cross_merchant_legacy_receipt_not_disclosed')
 receiptOwner='merchant-1';queryRows=[{...row(),receiptMerchantId:'another-merchant'}]
 res=await api.GET(req('Bearer good'),route());assert.equal(res.status,503);tests++;console.log('PASS mixed_ownership_row_fail_closed')
 queryRows=[row(),row()];res=await api.GET(req('Bearer good'),route());assert.equal(res.status,503);tests++;console.log('PASS duplicate_receipt_rows_fail_closed')
 // The GET wrapper uses the actual production source, evaluated in isolation.
 const recovery=read('app/api/recovery/transient/route.ts')
 assert.ok(recovery.includes('export async function POST(request: NextRequest)'))
 const snippet=recovery.match(/export async function GET\(request: NextRequest\) \{[\s\S]*?\n\}\n\nexport async function POST/)
 assert.ok(snippet,'GET handler missing')
 const fn=snippet[0].replace('\n\nexport async function POST','')
 const js=ts.transpileModule(fn,{compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2022}}).outputText.replace('export async function GET','async function GET')
 let posts=0;const context={Buffer,exports:{},NextResponse:JSONResponse,runtimeEnv:{CRON_SECRET:'synthetic-cron-secret'},constantTimeSecretEqual:(expected,got)=>!!expected&&!!got&&expected===got,POST:async()=>{posts++;return {status:200}},console:{warn:()=>{}}}
 const GET=vm.runInNewContext(js+'\nGET',context)
 let out=await GET({headers:{get:()=>null}});assert.equal(out.status,403);assert.equal(posts,0);tests++;console.log('PASS cron_get_missing_secret_denied')
 out=await GET({headers:{get:()=> 'Bearer wrong'}});assert.equal(out.status,403);assert.equal(posts,0);tests++;console.log('PASS cron_get_wrong_secret_denied')
 out=await GET({headers:{get:()=> 'Bearer synthetic-cron-secret'}});assert.equal(out.status,200);assert.equal(posts,1);tests++;console.log('PASS cron_get_valid_secret_delegates_to_post')
 context.runtimeEnv.CRON_SECRET=undefined
 out=await GET({headers:{get:()=> 'Bearer synthetic-cron-secret'}});assert.equal(out.status,403);assert.equal(posts,1);tests++;console.log('PASS cron_secret_missing_fails_closed')
 console.log('FIN100B_R32_ISOLATED_REGRESSION='+tests+'/'+tests+' PASS')
 console.log('FINANCIAL_OR_EXTERNAL_OUTBOUND=ZERO')
}
run().catch(e=>{console.error(e);process.exitCode=1})
