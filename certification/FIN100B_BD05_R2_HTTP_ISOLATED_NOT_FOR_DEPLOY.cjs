/** Isolated execution of the actual R2 GET handler: no sockets, DB, Redis or Pi/Horizon calls. */
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../app/api/payments/[id]/route.ts'), 'utf8')
const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const scenarios = [
  ['EXISTS', 'EXISTS', 503],
  ['ABSENT', 'ABSENT', 404],
  ['INDETERMINATE', 'INDETERMINATE', 503],
]
;(async () => {
 for (const [name, identityOutcome, expected] of scenarios) {
  const calls = []
  const fakeResponse = {json(body, opts={}) {return {status:opts.status || 200,body,headers:{set(){}}}}}
  const mocks = {
   'next/server': {NextResponse:fakeResponse},
   '@/lib/redis': {redis:{get:async key => {calls.push(['redis.get',key]);return null}},isRedisConfigured:true},
   '@/lib/payment-status': {isPaymentFinal:()=>false},
   '@/lib/merchant-auth': {authorizeFromHeader:()=>{throw Error('UNEXPECTED AUTH')}},
   '@/lib/db': {
    probeDurablePaymentIdentity: async id => {calls.push(['identity',id]);return identityOutcome},
    readSettlementRefundAuthority: async id => {calls.push(['authority',id]);return {outcome:'CLEAR',settlementActive:false,refundActive:false}},
    readSettlementPaymentIdentityPresence: async()=>{throw Error('OLD SINGLE TABLE PROBE CALLED')},
    getSettlementCheckpointAuthoritative:async()=>{throw Error('UNEXPECTED SETTLEMENT')},
    getDurableU2AIngressAuthoritative:async()=>{throw Error('UNEXPECTED INGRESS')},
    readSettlementU2AApprovalOwnership:async()=>{throw Error('UNEXPECTED APPROVAL')}
   },
   '@/lib/refund-checkpoint-store': {getRefundCheckpointsByPaymentIds:async ids => {calls.push(['refund',ids[0]]);return {state:'ok',checkpoints:new Map()}}},
   '@/lib/payment-projection-cas': {compareAndSwapPaymentProjection:async()=>{throw Error('UNEXPECTED CAS')}}
  }
  const sandbox = {exports:{},require(name){if(!(name in mocks))throw Error('UNMOCKED IMPORT '+name);return mocks[name]},console:{log(){},error(){}} ,process:{env:{VERCEL_REGION:'isolated'}}}
  vm.runInNewContext(js,sandbox,{filename:'app/api/payments/[id]/route.ts',timeout:1000})
  const id = 'fin100b-r2-legacy-only-probe'
  const response = await sandbox.exports.GET({headers:{get:()=>null}},{params:Promise.resolve({id})})
  assert.equal(response.status,expected, `${name}: unexpected status ${JSON.stringify(response.body)}`)
  assert.equal(calls.filter(c=>c[0]==='identity').length,1)
  assert.equal(calls.filter(c=>c[0]==='refund').length,1)
  assert.equal(calls.filter(c=>c[0]==='authority').length,1)
  console.log(`R2_GET_REDIS_MISS_${name}: PASS HTTP_${response.status}`)
 }
 console.log('ISOLATED_HANDLER_EXECUTION: 3/3 PASS')
 console.log('REAL_NETWORK_CALLS: ZERO (VM MOCKS)')
 console.log('REAL_DATABASE_WRITES: ZERO')
 console.log('PRODUCTION_WRITES: ZERO')
})().catch(e=>{console.error('R2_ISOLATED_HANDLER: FAIL',e);process.exitCode=1})
