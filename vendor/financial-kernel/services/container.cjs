'use strict';
const net=require('node:net'),fs=require('node:fs'),https=require('node:https'),tls=require('node:tls'),crypto=require('node:crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function input(){let b='';for await(const c of process.stdin){b+=c;if(b.length>2000000)throw Error('INPUT_SIZE')}return JSON.parse(b)}
function relay(port,host,target){const server=net.createServer(s=>{const u=net.connect({host,port:target});s.on('error',()=>u.destroy());u.on('error',()=>s.destroy());s.on('close',()=>u.destroy());u.on('close',()=>s.destroy());s.pipe(u).pipe(s)});server.listen(port,'0.0.0.0');return server}
function request(c){return new Promise(resolve=>{
 const data=c.body===undefined?undefined:JSON.stringify(c.body);let status;
 const r=https.request(c.url,{method:c.method||'GET',agent:false,ca:c.ca,cert:c.cert,key:c.key,rejectUnauthorized:true,
 checkServerIdentity:(h,p)=>tls.checkServerIdentity(h,p)|| (sha(new crypto.X509Certificate(p.raw).publicKey.export({type:'spki',format:'der'}))===c.pin?undefined:Error('PIN')),
 headers:data?{'content-type':'application/json'}:{}},s=>{status=s.statusCode;let b='';s.on('data',x=>{b+=x;if(b.length>8192)s.destroy()});s.on('end',()=>{let body;try{body=JSON.parse(b)}catch{body={error:'NON_JSON'}}resolve({status,body})})});
 r.setTimeout(5000,()=>r.destroy());r.on('error',e=>resolve({status:status||0,tlsOrTransportRejected:true,code:e.code||'IO'}));r.end(data);
})}
async function main(){const c=await input();const configured=c.kernelDeployment;delete c.kernelDeployment;if(!configured)throw Error('KERNEL_PROFILE_REQUIRED');process.env.KERNEL_DEPLOYMENT_PROFILE=configured.raw;process.env.KERNEL_DEPLOYMENT_SHA256=configured.sha256;const deployment=require('/kernel/dist/deployment.js').deployment();process.env.NEXT_PUBLIC_PI_NETWORK=deployment.network==='Pi Network'?'mainnet':'testnet';
 if(c.mode==='provider'){const {createR36ReadProxy}=require('/kernel/dist/lib/r36-provider-read-proxy.js');const s=createR36ReadProxy(c.service,c.piApiKey);await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(c.service.port,c.service.host,resolve)});relay(8443,'127.0.0.1',9443);console.log('READ_PROVIDER_LISTENING');return}
 if(c.mode==='producer'){
  const trace=require('/tools/phase-trace.cjs').createPhaseTrace({emit:event=>console.log(JSON.stringify(event))});
  const postgres=require('postgres'),{verifyR36ReadOnlySource}=require('/kernel/dist/lib/r36-live-source.js'),{dispatchR36EvidenceCycle}=require('/kernel/dist/lib/r36-evidence-dispatcher.js'),{createR36ReadProxyFetch}=require('/kernel/dist/lib/r36-provider-read-proxy.js'),{createR36RegistrarClient,createR36RegistryObserver,createR36LifecycleClient}=require('/kernel/dist/lib/r36-provider-transport.js'),{createR36AutomaticLifecycle}=require('/kernel/dist/lib/r36-automatic-lifecycle.js');
  const host=deployment.databaseHost,u=new URL(c.databaseUrl);if(u.protocol!=='postgresql:'||u.hostname!==host||u.username!=='r36_evidence_reader'||u.pathname!=='/'+deployment.databaseName||u.search||u.hash||!u.password)throw Error('READONLY_PRODUCER_TARGET');
  const sql=postgres(c.databaseUrl,{max:1,prepare:false,connect_timeout:8,idle_timeout:30,ssl:{rejectUnauthorized:true,servername:host,minVersion:'TLSv1.2'},onnotice:()=>{},connection:{application_name:'flashpay_r36_readonly_dispatcher',default_transaction_read_only:true,statement_timeout:30000,lock_timeout:3000}});
  const db={beginReadOnly:fn=>trace.run('database_snapshot',()=>sql.begin('isolation level repeatable read read only',async q=>({value:await fn({unsafe:s=>q.unsafe(s)})})).then(x=>x.value))};
  const snapshot=await verifyR36ReadOnlySource(db);if(snapshot.custody!=='READONLY_SERVICE_NOT_CERTIFIED')throw Error('READONLY_CUSTODY');
  // Preserve the original naive-timestamp interpretation, pinned in the
  // immutable source format. Fresh applications use their enrolled format;
  // an older installation keeps its existing process timezone until enrolled.
  const sourceZone=await db.beginReadOnly(async tx=>{const installed=await tx.unsafe("SELECT to_regclass('r36_evidence_source.installation') IS NOT NULL installed");if(installed[0]?.installed!==true)return null;const rows=await tx.unsafe("SELECT to_jsonb(i)->>'source_timezone' zone FROM r36_evidence_source.installation i WHERE singleton");if(rows.length!==1)throw Error('SOURCE_FORMAT_REQUIRED');return rows[0].zone});
  if(sourceZone!==null){if(!['UTC','Africa/Cairo'].includes(sourceZone))throw Error('SOURCE_TIMEZONE_UNQUALIFIED');process.env.TZ=sourceZone}
  const read=createR36ReadProxyFetch(c.provider),fetcher=(input,init)=>trace.run('provider_read',()=>read(input,init)),register=createR36RegistrarClient(c.registrar),observeOriginal=createR36RegistryObserver(c.issuer,c.config.registrarPolicyDigest),observe=signal=>trace.run('registry_observation',()=>observeOriginal(signal)),lifecycleOriginal=createR36LifecycleClient(c.issuer),lifecycle=(body,signal)=>trace.run(['prior_context','bound_context','record_prior','record_bound'].includes(body.action)?body.action:'lifecycle',()=>lifecycleOriginal(body,signal)),automatic=createR36AutomaticLifecycle(db,c.config,{fetcher,observe,lifecycle,register:b=>trace.run('registrar',()=>register(b,AbortSignal.timeout(135000)))});
  const {createProducerScheduler}=require('/tools/producer-scheduler.cjs'),{runProducerCycle}=require('/tools/producer-cycle.cjs');
  let financialCycleActive=false;
  const housekeeping=require('/tools/housekeeping-scheduler.cjs').createHousekeepingScheduler({
   now:Date.now,set:setTimeout,clear:clearTimeout,canRun:()=>!financialCycleActive,pass:()=>automatic.housekeeping(),
   report:a=>{if(a.released)console.log(JSON.stringify({phase:'CLOSED_LOCAL_COPIES_ARCHIVED',...a,financialAuthority:false}))},
   failed:()=>console.warn('[R36 storage] redundant local copies retained')});
  const space=()=>{const v=fs.statfsSync(c.config.jobDirectory);return v.bavail*v.bsize>=134217728};
  const scheduler=createProducerScheduler({set:setTimeout,clear:clearTimeout,fail:()=>process.exit(2),cycle:async()=>{
   const ingress=require('/tools/ingress-wake.cjs').readIngressTicket(c.ingressTicket);
   console.log(JSON.stringify({producerCycle:"started",at:new Date().toISOString()}));
   // Leave headroom for the bounded seven-artifact publication and durable
   // completion metadata. Cleanup may free space; it cannot invent authority.
   if(!space()){
    await housekeeping.kick();
    if(!space()){console.log(JSON.stringify({ingress,lifecycleStatus:'STORAGE_CAPACITY_HELD',dispatchStatus:'STORAGE_CAPACITY_HELD',jobs:0,published:0,held:1,policies:1,at:new Date().toISOString(),financialAuthority:false}));return 5000}
   }
   financialCycleActive=true;
   try{
   const {result:x,lifecycle:l,timing}=await runProducerCycle({automatic,dispatch:()=>dispatchR36EvidenceCycle(db,c.config,{fetcher,register:automatic.register,observeOwnerRegistry:observe})});
   console.log(JSON.stringify({ingress,lifecycleStatus:l.status,lifecycleReason:l.reason,dispatchStatus:x.status,policies:x.policies,jobs:x.jobs,published:x.published,held:x.held,reasons:x.reasons,timing,at:new Date().toISOString(),financialAuthority:false}));
   return x.policies?15000:600000;
   }finally{financialCycleActive=false;void housekeeping.kick()}
  }});
  process.on('SIGUSR1',()=>scheduler.kick());
  process.once('SIGTERM',()=>{scheduler.stop();housekeeping.stop();void sql.end({timeout:2}).finally(()=>process.exit(0))});console.log('READONLY_PRODUCER_READY');await scheduler.start();return
 }
 if(c.mode==='proxy'){if(!/^\d+\.\d+\.\d+\.\d+$/.test(c.ip))throw Error('TARGET');relay(5432,c.ip,5432);console.log('FIXED_DATABASE_PROXY_READY');return}
 if(c.mode==='probe'){
  const routes=fs.readFileSync('/proc/net/route','utf8');const defaultRoute=routes.trim().split('\n').slice(1).some(x=>x.trim().split(/\s+/)[1]==='00000000');
  const internetConnected=await new Promise(resolve=>{const s=net.connect({host:c.internetIp,port:443});const finish=v=>{s.destroy();resolve(v)};s.setTimeout(1500,()=>finish(false));s.on('connect',()=>finish(true));s.on('error',()=>finish(false))});
  const results=[];for(const q of c.requests)results.push({label:q.label,...await request(q)});
  console.log(JSON.stringify({defaultRoute,internetConnected,results}));return;
 }
 if(c.mode==='registrar'){delete c.mode;const {runRegistrationOperator}=require('/kernel/dist/lib/r36-registration-operator.js');const out=await runRegistrationOperator(c);relay(8443,'127.0.0.1',9443);console.log(JSON.stringify(out));return}
 const {runProductionOperator}=require('/kernel/dist/lib/r36-production-operator.js');
 const out=await runProductionOperator(c);relay(8443,'127.0.0.1',9443);console.log(JSON.stringify(out));
}
main().catch(e=>{console.error('PROTECTED_SERVICE_START_BLOCKED');process.exitCode=2});
