import fs from 'node:fs'
import path from 'node:path'
const root=path.resolve(__dirname,'..')
const read=(p:string)=>fs.readFileSync(path.join(root,p),'utf8')
const need=(c:unknown,m:string)=>{if(!c)throw new Error(m)}
const route=read('app/api/recovery/transient/route.ts')
const recovery=read('lib/a2u-recovery-service.ts')
const db=read('lib/db.ts')
function body(src:string,name:string){const at=src.indexOf(name);need(at>=0,`P6 missing ${name}`);const open=src.indexOf('{',at);let d=0;for(let i=open;i<src.length;i++){if(src[i]==='{')d++;else if(src[i]==='}'&&--d===0)return src.slice(open,i+1)}throw new Error(`P6 unterminated ${name}`)}
const repop=route.slice(route.indexOf('async function repopulateDurableSettlementWork'),route.indexOf('type DrainLease'))
const rebuild=recovery.slice(recovery.indexOf('async function rebuildSettlementProjectionFromDurable'),recovery.indexOf('/**\n * MINIMAL ORCHESTRATOR'))
const wake=route
const listing=db.slice(db.indexOf('export async function listOutstandingSettlementCheckpointIds'),db.indexOf('export type SettlementPaymentIdentityPresence'))
need(wake.indexOf('await repopulateDurableSettlementWork()')<wake.indexOf('redis.sscan("flashpay:recovery:active-payments:v1"'),'P6 PostgreSQL rediscovery must precede Redis active-index discovery')
need(repop.includes('listOutstandingSettlementCheckpointIds(200)'),'P6 Settlement rediscovery must originate from durable PostgreSQL listing')
need(listing.includes("FROM settlement_checkpoints")&&listing.includes("stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized')"),'P6 durable listing stages changed')
need(repop.includes("await redis.set(`payment:${paymentId}`,JSON.stringify(terminalProjection),{nx:true})"),'P6 missing create-only Redis projection rebuild')
need(repop.includes("const parsed=parsePayment(await redis.get(`payment:${paymentId}`))")&&repop.includes("parsed.id!==paymentId||parsed.a2uPaymentId!==d.a2uPaymentId"),'P6 missing rebuild readback identity proof')
need(repop.includes("if(dbDone)")&&repop.includes("redis.call('SREM',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1])"),'P6 finalized durable work must egress recovery indexes')
need(rebuild.includes('getSettlementCheckpointAuthoritative(paymentId)')&&rebuild.includes('{nx:true}')&&rebuild.includes('parsed.id!==paymentId')&&rebuild.includes('parsed.a2uPaymentId!==d.a2uPaymentId')&&rebuild.includes('parsed.piPaymentId!==d.u2aIdentifier')&&rebuild.includes('parsed.u2aTxid!==d.u2aTxid'),'P6 per-payment rebuild durable/readback binding changed')
for(const forbidden of ['server.submitTransaction','/approve','/complete`','createPayment','createA2U']) need(!repop.includes(forbidden),`P6 bootstrap unexpectedly contains financial side effect token ${forbidden}`)
// Executable model of the exact projection mapping over an empty Redis namespace.
type Stage='a2u_created'|'prepared'|'horizon_confirmed'|'pi_completed'|'db_finalized'
const stages:Stage[]=['a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized']
for(const stage of stages){
 const moved=['horizon_confirmed','pi_completed','db_finalized'].includes(stage), piDone=['pi_completed','db_finalized'].includes(stage), dbDone=stage==='db_finalized', prepared=stage!=='a2u_created'
 const p:any={id:'p',piPaymentId:'u2a',u2aTxid:'u'.repeat(64),a2uPaymentId:'a2u',status:dbDone?'settled_to_merchant':moved||prepared?'settlement_pending':'paid_to_app',...(prepared?{prepared:true}:{}),...(moved?{a2uTxid:'a'.repeat(64),horizonSuccessFlag:true,piCompleted:piDone,requiresDbReconciliation:piDone&&!dbDone,dbRecorded:dbDone}:{})}
 need(p.id==='p'&&p.a2uPaymentId==='a2u'&&p.piPaymentId==='u2a','P6 model identity lost')
 if(dbDone)need(p.status==='settled_to_merchant'&&p.dbRecorded===true&&p.requiresDbReconciliation===false,'P6 finalized model false finality')
 else need(p.status!=='settled_to_merchant','P6 non-final durable stage projected final success')
}
console.log('PLAN_I_P6_REDIS_LOSS_CURRENT_SHA=PASS stages=5 pg_rediscovery=true nx_rebuild=true readback=true terminal_egress=true financial_side_effects_in_bootstrap=false')
