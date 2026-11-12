'use strict';
// Protected local evidence pipeline. No policy enrollment or financial executor. Only the separate proxy has fixed provider GET capability.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),dns=require('node:dns').promises,crypto=require('node:crypto');
const {createCredentialReader}=require('./credential-store.cjs');
const load=createCredentialReader(process.env.CREDENTIALS_DIRECTORY);
const release=__dirname,root=fs.realpathSync(process.env.R36_DATA_DIRECTORY||'/var/lib/flashpay-r36');
const config=JSON.parse(fs.readFileSync(path.join(release,'HOST_CONFIG.json')));
if(process.platform!=='linux'||config.schema!=='FLASHpay_PRIVATE_LINUX_HOST_V1'||!Number.isSafeInteger(config.containerUid)||config.containerUid<1000)throw Error('LINUX_HOST_REQUIRED');
const deployment=require('/kernel/dist/deployment.js').deployment();const host=deployment.databaseHost,label='org.flashpay.r36.'+deployment.applicationId;
const names=['fp-r36-live-db','fp-r36-live-evidence','fp-r36-live-signer','fp-r36-live-issuer','fp-r36-live-registrar','fp-r36-live-provider','fp-r36-live-producer'],net='fp-r36-live-private',egress='fp-r36-live-neon';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const policyFile=path.join(root,'ACTIVE_POLICY.json');
function readConfiguredPolicy(){
 try{const s=fs.lstatSync(policyFile);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.size>2048)throw Error('POLICY_CONFIG_STORAGE');const p=JSON.parse(fs.readFileSync(policyFile,'utf8'));if(Object.keys(p).sort().join(',')!=='policyDigest,schema'||p.schema!=='R36_PROTECTED_SERVICE_POLICY_V1'||!/^[0-9a-f]{64}$/.test(p.policyDigest))throw Error('POLICY_CONFIG_SCOPE');return p.policyDigest}
 catch(e){if(e.code==='ENOENT')return null;throw e}
}
const configuredPolicy=readConfiguredPolicy();
const certificateWake=require('./certificate-wake.cjs').production(root,load);
const {createCycleActivity}=require('./cycle-activity.cjs');
const producerActivity=createCycleActivity();
const phaseEvents=[];function collectPhase(j){if(!j||!/^[a-z_]{1,40}$/.test(j.r36Phase)||!Number.isSafeInteger(j.phaseId)||!['start','end'].includes(j.event)||!Number.isFinite(Date.parse(j.at)))return;const e={r36Phase:j.r36Phase,phaseId:j.phaseId,event:j.event,at:j.at};if(j.event==='end'&&Number.isSafeInteger(j.ms)&&j.ms>=0&&['returned','rejected'].includes(j.outcome)){e.ms=j.ms;e.outcome=j.outcome}phaseEvents.push(e);if(phaseEvents.length>256)phaseEvents.shift()}
function savePhases(){try{saved('PHASE_TRACE',{at:new Date().toISOString(),events:phaseEvents})}catch{}}
const policyDigest=configuredPolicy??sha('FLASHpay technical service qualification only; disabled policy; no financial approval; 20261107');
function saved(name,v){const p=path.join(root,'scratch',name+'.json'),temp=p+'.tmp';fs.writeFileSync(temp,JSON.stringify(v,null,2)+'\n',{mode:0o600});fs.renameSync(temp,p)}
function databaseSecret(mode,role){if(mode!=='get'||!['r36_issuer','r36_signer','r36_registrar','r36_evidence_reader'].includes(role))throw Error('DATABASE_ROLE');return load(role)}
function docker(args,input){const r=cp.spawnSync('/usr/bin/docker',args,{input,encoding:'utf8',maxBuffer:1000000,timeout:20000});if(r.status!==0){saved('DOCKER_START_DIAGNOSTIC',{verb:args[0],status:r.status,error:r.error?.code,stderr:String(r.stderr).slice(0,4000)});throw Error('DOCKER_OPERATION_FAILED')}return r.stdout.trim()}
function existing(kind,name){const r=cp.spawnSync('/usr/bin/docker',[kind,'inspect',name],{encoding:'utf8',timeout:10000});return r.status===0?JSON.parse(r.stdout)[0]:null}
function inspectLock(){const lock=JSON.parse(fs.readFileSync(path.join(release,'SOURCE_LOCK.json')));for(const [f,h]of Object.entries(lock.files)){if(!f.split('/').every(segment=>/^[a-zA-Z0-9_.-]+$/.test(segment)||/^\[[a-zA-Z][a-zA-Z0-9_]*\]$/.test(segment))||f.split('/').includes('..')||path.isAbsolute(f)||sha(fs.readFileSync(path.join(release,f)))!==h)throw Error('SOURCE_LOCK_MISMATCH')}if(!/^sha256:[0-9a-f]{64}$/.test(config.image))throw Error('IMAGE_NOT_PINNED');return {...lock,image:config.image}}
const ssl=require('./tls-command.cjs').runTls;
async function tlsIdentities(){
 const authority=load('tls-ca'),cfg='[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n';
 const ca=await ssl(['req','-new','-x509','-sha256','-days','2','-key','/dev/fd/3','-config','/dev/fd/4','-subj','/CN=FLASHpay R36 private technical TLS CA'],[authority.key,cfg]);
 const result={};for(const name of ['issuer','signer','evidence-server','controller','registrar','producer','provider']){
  const prior=name==='registrar'?load('tls-registrar'):['producer','provider'].includes(name)?load('tls-'+name):load(name),key=prior.key,dnsName='r36-'+name+'.internal';
  const csr=await ssl(['req','-new','-sha256','-key','/dev/fd/3','-subj','/CN='+dnsName],[key]);
  const ext='basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyAgreement\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:'+dnsName+'\n';
  const cert=await ssl(['x509','-req','-sha256','-days','1','-CA','/dev/fd/3','-CAkey','/dev/fd/4','-extfile','/dev/fd/5','-set_serial','0x'+crypto.randomBytes(16).toString('hex')],[ca,authority.key,ext],csr);
  const x=new crypto.X509Certificate(cert);result[name]={key,cert,ca,spki:sha(x.publicKey.export({type:'spki',format:'der'})),validTo:x.validTo,...(name==='signer'?{signing:prior.signing}:{})};
 }
 const qualified=JSON.parse(fs.readFileSync(path.join(release,'PUBLIC_IDENTITIES.json')));for(const [name,x]of Object.entries(result))if(x.spki!==qualified.tls[name].spki)throw Error('KEY_CUSTODY_CHANGED');
 return result;
}
const mounts=[]; // Compiled modules, locked dependencies and tools are inside the pinned image.
const restrictions=['--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user',String(config.containerUid)+':'+String(config.containerUid),'--pids-limit','80','--memory','160m','--cpus','0.6','--log-driver','none','--label','org.flashpay.owner='+label];
let children=[],state={label,mode:configuredPolicy?'PROTECTED_POLICY_SERVICES_REQUIRE_DATABASE_APPROVAL':'STANDBY_NO_FINANCIAL_POLICY',financialAuthority:false,pid:process.pid,hostBootId:process.env.R36_HOST_BOOT_ID||null,generation:crypto.randomUUID(),startedAt:new Date().toISOString()},closing=false;
async function cleanup(){for(const n of names.slice().reverse()){const x=existing('container',n);if(x){if(x.Config.Labels?.['org.flashpay.owner']!==label)throw Error('FOREIGN_CONTAINER');try{docker(['rm','-f',n])}catch(e){if(existing('container',n))throw e}}}
 for(const n of [net,egress]){const x=existing('network',n);if(x){if(x.Labels?.['org.flashpay.owner']!==label)throw Error('FOREIGN_NETWORK');try{docker(['network','rm',n])}catch(e){if(existing('network',n))throw e}}}}
function start(name,c,ready){c.kernelDeployment={raw:process.env.KERNEL_DEPLOYMENT_PROFILE,sha256:process.env.KERNEL_DEPLOYMENT_SHA256};return new Promise((resolve,reject)=>{const p=cp.spawn('/usr/bin/docker',['start','-a','-i',name],{stdio:['pipe','pipe','pipe']});children.push(p);let buffer='';const t=setTimeout(()=>reject(Error('SERVICE_NOT_READY')),20000);p.stdout.on('data',bytes=>{buffer+=bytes;for(;;){const i=buffer.indexOf('\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.includes(ready)){p._flashpayReady=true;clearTimeout(t);resolve({name,result:ready})}if(name===names[6]){try{const j=JSON.parse(line);collectPhase(j);producerActivity.observe(j);if(j.dispatchStatus){saved('DISPATCH_STATUS',j);void certificateWake.pulse(j,configuredPolicy).then(x=>{if(x.status!=='NO_CERTIFICATE_EVENT')saved('CERTIFICATE_WAKE_STATUS',x);
 // React to a completed original checkpoint instead of waiting another 15s.
 // Holds, delivery uncertainty and failed requests never trigger this hint.
 if(!closing&&x.status==='EVENT_WAKE_DELIVERED'&&['preparation_invoked','inbound_observation_invoked','settlement_invoked','refund_invoked','refund_finalization_invoked','refund_projection_invoked','terminal_seal_recorded','terminal_presentation_recorded'].includes(x.dispatch)){
  const signal=cp.spawn('/usr/bin/docker',['kill','--signal=USR1',names[6]],{stdio:'ignore'});signal.on('error',()=>{});
 }})}}catch{}}}if(buffer.length>100000)void finish(2)});p.stderr.resume();p.on('error',()=>{clearTimeout(t);reject(Error('SERVICE_FAILED'))});p.on('close',()=>{clearTimeout(t);if(!p._flashpayReady)reject(Error('SERVICE_NOT_READY'));else if(!closing){state.failure='SERVICE_EXIT';void finish(2)}});p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify(c))})}
async function finish(code){if(closing)return;closing=true;try{await cleanup()}catch{state.cleanup='FAILED'}savePhases();state.running=false;state.stoppedAt=new Date().toISOString();saved('DURABLE_STATUS',state);process.exit(code)}
async function run(){
 const startupAt=Date.now(),timing={};const lock=inspectLock(),keys=await tlsIdentities();await cleanup();timing.identityAndCleanupMs=Date.now()-startupAt;
 const credentials={};for(const role of ['r36_signer','r36_issuer','r36_registrar','r36_evidence_reader']){const c=databaseSecret('get',role);if(c.role!==role||c.host!==host||c.database!==deployment.databaseName||!/^[A-Za-z0-9_-]{64}$/.test(c.password))throw Error('CREDENTIAL_TARGET');credentials[role]=c}
 const image=lock.image,ip=(await dns.lookup(host,{family:4})).address;
 const network=(n,internal)=>docker(['network','create',...(internal?['--internal']:[]),'--label','org.flashpay.owner='+label,n]);network(net,true);network(egress,false);
 function create(name,network,alias,extra=[]){docker(['create','-i','--name',name,'--network',network,...(alias?['--network-alias',alias]:[]),...restrictions,...mounts,...extra,image,'node','/tools/container.cjs'])}
 function svc(name,allowed){const k=keys[name];return{host:'127.0.0.1',port:9443,serverCertPem:k.cert,serverKeyPem:k.key,clientCaPem:k.ca,clientPins:allowed.map(x=>keys[x].spki)}}
 function endpoint(name,client='issuer'){return{origin:'https://r36-'+name+'.internal:8443',serverSpkiSha256:keys[name].spki,caPem:keys[client].ca,clientCertPem:keys[client].cert,clientKeyPem:keys[client].key}}
 const url=role=>'postgresql://'+role+':'+credentials[role].password+'@'+host+':5432/'+deployment.databaseName;
 create(names[0],egress);docker(['network','connect','--alias',host,net,names[0]]);await start(names[0],{mode:'proxy',ip},'FIXED_DATABASE_PROXY_READY');
 create(names[1],net,'r36-evidence-server.internal',['--mount','type=bind,src='+path.join(root,'artifacts')+',dst=/artifacts,readonly']);create(names[2],net,'r36-signer.internal');create(names[3],net,'r36-issuer.internal');create(names[4],net,'r36-registrar.internal');
 create(names[5],egress,null,['--mount','type=bind,src=/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem,dst=/tmp/r36-proxy-ca.pem,readonly','-e','NODE_EXTRA_CA_CERTS=/tmp/r36-proxy-ca.pem']);docker(['network','connect','--alias','r36-provider.internal',net,names[5]]);
 const dependenciesAt=Date.now();timing.networkAndContainersMs=dependenciesAt-startupAt-timing.identityAndCleanupMs;
 const {startServiceGroup}=require('./service-start-group.cjs');
 state.services=await startServiceGroup([
  ()=>start(names[1],{mode:'evidence',network:'Pi Testnet',service:svc('evidence-server',['issuer','registrar']),directory:'/artifacts'},'EVIDENCE_LISTENING'),
  ()=>start(names[2],{mode:'signer',network:'Pi Testnet',databaseUrl:url('r36_signer'),policyDigest,approvalId:null,service:svc('signer',['issuer']),signingKeyPem:keys.signer.signing.privateKeyPem},'SIGNER_LISTENING'),
  ()=>start(names[3],{mode:'issuer',network:'Pi Testnet',databaseUrl:url('r36_issuer'),policyDigest,approvalId:null,service:svc('issuer',['controller','registrar','producer']),providers:{evidence:endpoint('evidence-server'),signer:endpoint('signer')}},'ISSUER_LISTENING'),
  ()=>start(names[4],{mode:'registrar',network:'Pi Testnet',databaseUrl:url('r36_registrar'),policyDigest,service:svc('registrar',['controller','producer']),providers:{evidence:endpoint('evidence-server','registrar'),issuer:endpoint('issuer','registrar')}},'REGISTRAR_LISTENING'),
  ()=>start(names[5],{mode:'provider',service:svc('provider',['producer']),piApiKey:load('pi-provider').apiKey},'READ_PROVIDER_LISTENING')
 ]);timing.dependenciesMs=Date.now()-dependenciesAt;
 const producerAt=Date.now();
 create(names[6],net,null,['-e','TZ=Africa/Cairo','--mount','type=bind,src='+path.join(root,'artifacts')+',dst=/artifacts','--mount','type=bind,src='+path.join(root,'jobs')+',dst=/jobs','--mount','type=bind,src='+path.join(root,'facts')+',dst=/facts,readonly']);
 state.services.push(await start(names[6],{mode:'producer',databaseUrl:url('r36_evidence_reader'),config:{factsDirectory:'/facts',jobDirectory:'/jobs',artifactDirectory:'/artifacts',custodianPrivateKeyPem:load('evidence-custodian').privateKeyPem,custodyDecryptionKey:load('custody-decryption').privateKeyPem,registrarPolicyDigest:policyDigest},provider:endpoint('provider','producer'),registrar:endpoint('registrar','producer'),issuer:endpoint('issuer','producer')},'READONLY_PRODUCER_READY'));
 timing.producerStartupMs=Date.now()-producerAt;timing.servicesReadyMs=Date.now()-startupAt;state.startupTiming=timing;
 state.running=true;state.policyEnrollment='VERIFIED_BY_ORIGINAL_DATABASE_GUARDS_NOT_BY_SUPERVISOR';state.configuredPolicyDigest=configuredPolicy;state.privateKeyStore=config.credentialMode==='ephemeral-tmpfs'?'EPHEMERAL_TMPFS_CREDENTIALS':'SYSTEMD_ENCRYPTED_CREDENTIALS';state.tls=Object.fromEntries(Object.entries(keys).map(([n,k])=>[n,{spki:k.spki,validTo:k.validTo}]));state.readyAt=new Date().toISOString();
 state.containers=names.map(n=>{const c=existing('container',n);return{name:n,id:c.Id,pid:c.State.Pid,networks:Object.keys(c.NetworkSettings.Networks),ports:c.HostConfig.PortBindings,readonly:c.HostConfig.ReadonlyRootfs}});
 if(state.containers.slice(1).filter(c=>c.name!==names[5]).some(c=>c.networks.join()!==net||Object.keys(c.ports||{}).length||!c.readonly))throw Error('ISOLATION_CHANGED');
 saved('DURABLE_STATUS',state);console.log('R36_PROTECTED_STANDBY_READY');
 // Rotate only technical TLS certificates at 12h, retaining all pinned keys. Private evidence dispatcher is active; absent approved policy remains standby. No financial executor is enabled.
 // Drain the original bounded notification instead of killing its HTTP caller.
 // This never extends a certificate, financial right or provider request. The
 // private VM still expires at 300s; stop by 280s with durable pending retained.
 if(config.credentialMode==='ephemeral-tmpfs'){
  const deadline=Date.now()+280000;
  function expire(){if(certificateWake.deliveryActive()&&Date.now()<deadline){setTimeout(expire,1000);return}void finish(0)}
  setTimeout(expire,220000);
 }else setTimeout(()=>finish(0),12*60*60*1000);
 if(config.credentialMode==='ephemeral-tmpfs')setInterval(()=>{try{const touch=fs.statSync('/run/flashpay-r36/wake').mtimeMs;const d=JSON.parse(fs.readFileSync(path.join(root,'scratch/DISPATCH_STATUS.json')));let w={pending:false};try{w=JSON.parse(fs.readFileSync(path.join(root,'scratch/CERTIFICATE_WAKE_BUDGET.json')))}catch(e){if(e.code!=='ENOENT')throw e}if(producerActivity.canIdleStop({now:Date.now(),lastWake:touch,dispatch:d,pending:w.pending}))void finish(0)}catch{}},5000);
 setInterval(()=>{savePhases();state.heartbeatAt=new Date().toISOString();saved('DURABLE_STATUS',state)},5000);
}
module.exports={databaseSecret,inspectLock,root,label,host,policyDigest,cleanup};
if(require.main===module){process.once('SIGTERM',()=>finish(0));process.once('SIGINT',()=>finish(0));run().catch(e=>{state.failure=/^[A-Z_]+$/.test(e.message)?e.message:'SAFE_ERROR';void finish(2)})}
