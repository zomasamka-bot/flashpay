import {deployment} from '../deployment'
/** Private registrar process. No owner credential, signing key, browser route,
 * financial transport, policy enrollment or wallet activation is accepted. */
import postgres from 'postgres'
import {once} from 'node:events'
import {registerR36CertificateRequest} from './r36-certificate-registrar'
import {createR36EvidenceReader,createR36IssuerClient,createR36RegistryObserver,type R36ProviderEndpoint} from './r36-provider-transport'
import {createR36OperatorService,type R36ServiceConfig} from './r36-operator-service'
import {productionR36Host,productionR36Branch} from './r36-production-runtime'
import type {R36CertificateDatabase,R36CertificateResult} from './r36-certificate-consumer'
import type {R36WorkerPorts} from './r36-certificate-worker'

const hex=/^[0-9a-f]{64}$/
const noAuthority={authorizesFinancialRelease:false,authorizesWalletActivation:false,authorizesRotation:false} as const
type Tx=Parameters<Parameters<R36CertificateDatabase['begin']>[0]>[0]
type Config={network:'Pi Testnet';databaseUrl:string;policyDigest:string;service:R36ServiceConfig;
 providers:{evidence:R36ProviderEndpoint;issuer:R36ProviderEndpoint}}
const blocked=(reason:string):R36CertificateResult=>({outcome:'BLOCKED',reason,...noAuthority})

export function validateRegistrationConfig(input:unknown):Config{
 const c=input as Config
 if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).sort().join()!=='databaseUrl,network,policyDigest,providers,service'||
  c.network!=='Pi Testnet'||typeof c.policyDigest!=='string'||!hex.test(c.policyDigest))throw Error('REGISTRAR_CONFIG')
 const u=new URL(c.databaseUrl),s=c.service,p=c.providers
 if(u.protocol!=='postgresql:'||u.hostname!==productionR36Host||(u.port&&u.port!=='5432')||u.pathname!==('/'+deployment().databaseName)||
  u.username!=='r36_registrar'||!u.password||u.search||u.hash)throw Error('REGISTRAR_DATABASE_TARGET')
 if(!s||!['127.0.0.1','::1'].includes(s.host)||!Number.isInteger(s.port)||s.port<1||s.port>65535)throw Error('REGISTRAR_PRIVATE_SERVICE')
 if(!p||Object.keys(p).sort().join()!=='evidence,issuer'||!p.evidence||!p.issuer||
  new URL(p.evidence.origin).origin===new URL(p.issuer.origin).origin||p.evidence.serverSpkiSha256===p.issuer.serverSpkiSha256)
  throw Error('REGISTRAR_PROVIDERS_NOT_SEPARATE')
 // Validate pinned transports before accepting a DB credential or a request.
 createR36EvidenceReader(p.evidence);createR36IssuerClient(p.issuer)
 return c
}

/** Each real connection/reconnection must remain the restricted direct role. */
export async function checkRegistrationTransaction(tx:Tx){
 const rows=await tx.unsafe(`SELECT
 current_database()='${deployment().databaseName}' AND current_setting('neon.branch_id',true)=$1
 AND session_user='r36_registrar' AND current_user='r36_registrar' AS identity_ok,
 r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
 AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
 AND NOT has_database_privilege(r.oid,current_database(),'CREATE') AS restricted,
 NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
 AND has_schema_privilege(r.oid,n.oid,'CREATE')) AS no_schema_create,
 NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
 AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS no_direct_tables,
 NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
 WHERE (n.nspname IN ('r36_registration','r36_signing') OR n.nspname='public' AND f.proname LIKE 'r36_%')
 AND has_function_privilege(r.oid,f.oid,'EXECUTE') AND NOT(n.nspname='r36_registration'
 AND (f.proname,oidvectortypes(f.proargtypes)) IN (('context','text, text'),('enroll','text, jsonb, text, text, bigint, bigint, text')))) AS function_scope,
 has_function_privilege(r.oid,'r36_registration.context(text,text)','EXECUTE') AND
 has_function_privilege(r.oid,'r36_registration.enroll(text,jsonb,text,text,bigint,bigint,text)','EXECUTE') AS registration_available
 FROM pg_roles r WHERE r.rolname=current_user`,[productionR36Branch])
 if(rows.length!==1||!['identity_ok','restricted','no_schema_create','no_direct_tables','function_scope','registration_available'].every(k=>rows[0][k]===true))
  throw Error('REGISTRAR_DATABASE_AUTHORITY')
}

/** The original registrar gets only its two exact calls for this policy/nonce. */
export function scopeRegistrationTransaction(tx:Tx,policyDigest:string,nonce:string):Tx{
 if(!hex.test(policyDigest)||!hex.test(nonce))throw Error('REGISTRATION_SCOPE')
 let reviewed=false
 return {unsafe:async(q,v)=>{
  if(q==='SELECT r36_registration.context($1,$2) AS context'&&v?.length===2&&v[0]===policyDigest&&v[1]===nonce){
   const rows=await tx.unsafe(q,v);reviewed=rows.length===1&&!!rows[0].context;return rows
  }
  if(q==='SELECT r36_registration.enroll($1,$2::text::jsonb,$3,$4,$5,$6,$7) AS outcome'&&v?.length===7&&
   reviewed&&v[0]===policyDigest&&typeof v[1]==='string'&&JSON.parse(v[1]).nonce===nonce)return tx.unsafe(q,v)
  throw Error('REGISTRATION_QUERY_SCOPE')
 }}
}

/** Commit the original reviewed request before calling the independent issuer.
 * Crash/timeout never rolls back a committed permission or invents a new nonce:
 * retrying the same immutable binding follows the existing SQL replay contract. */
export async function registerAndIssueR36(db:R36CertificateDatabase,policyDigest:string,binding:unknown,
 readEvidence:R36WorkerPorts['readEvidence'],issue:ReturnType<typeof createR36IssuerClient>,
 observeOwnerRegistry?:ReturnType<typeof createR36RegistryObserver>):Promise<R36CertificateResult>{
 try{
  // Bind the follow-up before the first await, just as the original registrar
  // snapshots its evidence binding. A caller must not swap the nonce in flight.
  const immutable=structuredClone(binding),nonce=(immutable as {nonce?:unknown}|null)?.nonce
  if(typeof nonce!=='string'||!hex.test(nonce))return blocked('INVALID_REGISTRATION_NONCE')
  let startedAt:number|undefined
  if(observeOwnerRegistry){
   // End the read transaction before observation: context holds a policy share
   // lock, while the issuer refresh needs that row's update lock. This capture
   // grants nothing and persists no request or signing permission.
   const rows=await db.begin(tx=>tx.unsafe('SELECT r36_registration.context($1,$2) AS context',[policyDigest,nonce]))
   const c=rows.length===1?rows[0].context as {nowSeconds?:unknown;policy?:{policyDigest?:unknown}}|null:null
   if(!c||!Number.isSafeInteger(c.nowSeconds)||c.policy?.policyDigest!==policyDigest)return blocked('REGISTRATION_START_UNAVAILABLE')
   startedAt=c.nowSeconds as number
   await observeOwnerRegistry(AbortSignal.timeout(8000))
  }
  const r=await registerR36CertificateRequest(db,policyDigest,immutable,readEvidence,startedAt)
  if(r.outcome==='BLOCKED')return blocked(r.reason)
  const out=await issue(nonce,AbortSignal.timeout(71000))
  if(!['RECORDED','REPLAYED'].includes(out.outcome)||!out.certificateDigest||!hex.test(out.certificateDigest)||
   out.authorizesFinancialRelease!==false||out.authorizesWalletActivation!==false||out.authorizesRotation!==false)
   return blocked('REGISTRATION_COMMITTED_ISSUER_RESPONSE_REJECTED')
  return {outcome:out.outcome,reason:'REGISTERED_AND_ISSUED_REQUIRES_ORIGINAL_FINANCIAL_GUARDS',certificateDigest:out.certificateDigest,...noAuthority}
 }catch{return blocked('REGISTRATION_OR_ISSUER_UNAVAILABLE_RETRY_SAME_BINDING')}
}

export async function runRegistrationOperator(input:unknown){
 const c=validateRegistrationConfig(input),u=new URL(c.databaseUrl)
 // Neon terminates the verified client TLS connection at its proxy. pg_stat_ssl
 // describes the proxy-to-backend hop and cannot certify client transport.
 // Every driver connection/reconnect requires TLS and verifies CA + hostname;
 // no caller-supplied SSL option or plaintext/prefer fallback is accepted.
 const sql=postgres({host:productionR36Host,port:5432,database:deployment().databaseName,username:'r36_registrar',password:decodeURIComponent(u.password),
  ssl:{rejectUnauthorized:true,servername:productionR36Host,minVersion:'TLSv1.2'},prepare:false,max:1,idle_timeout:30,connect_timeout:8,onnotice:()=>{}})
 let listening=false
 try{
  const databaseFor=(nonce:string):R36CertificateDatabase=>({begin:async fn=>{
   const r=await sql.begin(async q=>{const tx:Tx={unsafe:async(query,values)=>q.unsafe(query,values as never)}
    await checkRegistrationTransaction(tx)
    return {value:await fn(scopeRegistrationTransaction(tx,c.policyDigest,nonce))}
   });return r.value
  }})
  await sql.begin(q=>checkRegistrationTransaction({unsafe:async(query,values)=>q.unsafe(query,values as never)}))
  const read=createR36EvidenceReader(c.providers.evidence),issue=createR36IssuerClient(c.providers.issuer),observe=createR36RegistryObserver(c.providers.issuer,c.policyDigest)
  const server=createR36OperatorService(c.service,{kind:'registrar',register:async binding=>{
   const nonce=(binding as {nonce?:unknown}|null)?.nonce
   if(typeof nonce!=='string'||!hex.test(nonce))return blocked('INVALID_REGISTRATION_NONCE')
   return registerAndIssueR36(databaseFor(nonce),c.policyDigest,binding,read,issue,observe)
  }})
  const ready=once(server,'listening');server.listen(c.service.port,c.service.host);await ready;listening=true
  const close=()=>server.close();process.once('SIGTERM',close);process.once('SIGINT',close)
  server.once('close',()=>{process.off('SIGTERM',close);process.off('SIGINT',close);void sql.end({timeout:2})})
  return {outcome:'REGISTRAR_LISTENING',scope:'SINGLE_POLICY_ORIGINAL_EVIDENCE_REVIEW',...noAuthority}
 }finally{if(!listening)await sql.end({timeout:2})}
}

if(require.main===module){void(async()=>{
 const chunks:Buffer[]=[];let size=0
 for await(const data of process.stdin){const b=Buffer.from(data);size+=b.length;if(size>2_000_000)throw Error('CONFIGURATION_SIZE');chunks.push(b)}
 const result=await runRegistrationOperator(JSON.parse(Buffer.concat(chunks).toString('utf8')))
 process.stdout.write(JSON.stringify(result)+'\n')
})().catch(()=>{process.stderr.write('R36_REGISTRATION_OPERATOR_BLOCKED\n');process.exitCode=2})}
