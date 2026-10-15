'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const ts=require('typescript');
const src=fs.readFileSync(require('path').join(__dirname,'../lib/merchant-history-durable.ts'),'utf8');
const js=ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function row(overrides={}) {return {
 paymentId:'payment-1',merchantId:'merchant-1',merchantUid:'uid-1',amount:'1.2',createdAt:'2026-01-01T00:00:00.000Z',createdAtMs:String(Date.parse('2026-01-01T00:00:00.000Z')),
 checkpointId:'payment-1',checkpointMerchantId:'merchant-1',checkpointMerchantUid:'uid-1',checkpointAmount:'1.2',merchantAmount:'1.2',commission:'0',
 intentId:null,intentMerchantId:null,intentMerchantUid:null,intentAmount:null,
 evidenceId:'payment-1',evidenceMerchantId:'merchant-1',evidenceMerchantUid:'uid-1',evidenceAmount:'1.2', ...overrides
}}
async function execute(rows, exists=true){
 const exports={};const sandbox={exports,require(name){if(name!=='@/lib/db')throw Error('unknown import');return {query:async(sql)=>sql.includes('to_regclass(')?[{exists}]:rows}},Map,Set,Number,Date,Error,String};
 vm.runInNewContext(js,sandbox,{filename:'merchant-history-durable.js'});
 return exports.listDurableMerchantHistoryIdentities();
}
async function fails(rows,message){try{await execute(rows);throw Error('EXPECTED_FAILURE')}catch(e){assert.notEqual(e.message,'EXPECTED_FAILURE');assert.ok(e.message.includes(message),e.message)}}
(async()=>{
 assert.equal((await execute([row()])).length,1);
 await fails([row({evidenceId:null,evidenceMerchantId:null,evidenceMerchantUid:null,evidenceAmount:null})],'original creation evidence absent');
 await fails([row({createdAt:'1970-01-01T00:00:00.000Z',createdAtMs:'0'})],'contradictory');
 await fails([row({evidenceMerchantUid:'someone-else'})],'evidence identity contradictory');
 await fails([row(),row()],'duplicate');
 await fails([row({merchantAmount:'1.3'})],'contradictory');
 const modern=row({intentId:'payment-1',intentMerchantId:'merchant-1',intentMerchantUid:'uid-1',intentAmount:'1.2', evidenceId:null,evidenceMerchantId:null,evidenceMerchantUid:null,evidenceAmount:null});
 assert.equal((await execute([modern],false)).length,1);
 console.log('FIN100B_LEGACY_TEMPORAL_CONTRACT_TESTS=7/7 PASS');
 console.log('NO_EXTERNAL_DB_OR_REDIS=YES');
})().catch(e=>{console.error(e);process.exitCode=1});
