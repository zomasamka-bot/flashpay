/** Standalone NOT_FOR_DEPLOY entry point. Configuration/secrets arrive on stdin only.
 * No .env lookup, command-line credentials, financial endpoint or production fallback.
 */
import postgres from 'postgres'
import {createR36HttpsPorts} from './r36-provider-transport'
import {createR36OperatorService} from './r36-operator-service'
import {certifyR36PreparedAdmission} from './r36-trusted-certification-gate'
import type {R36CertificateDatabase} from './r36-certificate-consumer'
const B2='ep-twilight-bread-b9ehaewq.c-7.eu-central-1.aws.neon.tech'
export async function runR36Operator(config:Record<string,unknown>){
 if(config.scope!=='B2_NONPRODUCTION_ONLY')throw Error('SCOPE_REQUIRED')
 const mode=config.mode
 if(mode!=='worker'&&mode!=='signer'&&mode!=='evidence')throw Error('MODE_INVALID')
 let sql:ReturnType<typeof postgres>|undefined
 if(mode!=='evidence'){
  const d=config.database as {url:string;caPem?:string;serverName?:string}
  const u=new URL(d.url),role=mode==='worker'?'r36_issuer':'r36_signer'
  if(u.protocol!=='postgresql:'||u.username!==role||u.pathname!=='/neondb'||u.search||u.hash||![B2,'r36-code-pg'].includes(u.hostname))throw Error('DATABASE_TARGET_NOT_ALLOWED')
  sql=postgres(d.url,{max:1,prepare:false,connect_timeout:10,idle_timeout:10,ssl:{rejectUnauthorized:true,...(d.caPem?{ca:d.caPem}:{}),servername:d.serverName??u.hostname},onnotice:()=>{}})
  let identity
  try{identity=await sql`SELECT session_user,current_user,current_database() database`}catch(e){await sql.end({timeout:1});throw e}
  if(identity.length!==1||identity[0].session_user!==role||identity[0].current_user!==role||identity[0].database!=='neondb'){await sql.end({timeout:1});throw Error('DATABASE_ROLE_MISMATCH')}
  try{
   const acl=await sql`SELECT NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication) AS restricted,
    NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS no_membership,
    NOT has_schema_privilege(current_user,'public','CREATE') AS no_public_create,
    NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.relkind IN ('r','p') AND c.relname IN ('transactions','receipts','merchant_balances','refund_accounting_records')
      AND has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')) AS no_financial_mutation
    FROM pg_roles r WHERE r.rolname=current_user`
   if(acl.length!==1||Object.values(acl[0]).some(v=>v!==true))throw Error('DATABASE_ACL_UNSAFE')
  }catch(e){await sql.end({timeout:1});throw e}
 }
 const db=sql?{begin:async<T>(f:Parameters<R36CertificateDatabase['begin']>[0])=>sql!.begin(async tx=>f({unsafe:async(q,v)=>await tx.unsafe(q,v as never)})) as Promise<T>}:undefined
 if(mode==='worker'){
  try{return await certifyR36PreparedAdmission(db as R36CertificateDatabase,String(config.nonce),createR36HttpsPorts(config.providers as Parameters<typeof createR36HttpsPorts>[0]))}
  finally{await sql!.end({timeout:2})}
 }
 try{
 const c=config.service as Parameters<typeof createR36OperatorService>[0]
 const server=createR36OperatorService(c,mode==='evidence'?{kind:'evidence',directory:String(config.directory)}:{kind:'signer',db:db as R36CertificateDatabase,signingKeyPem:String(config.signingKeyPem)})
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(c.port,c.host,resolve)})
 const close=()=>server.close(()=>{void sql?.end({timeout:2}).finally(()=>process.exit(0));if(!sql)process.exit(0)})
 process.once('SIGTERM',close);process.once('SIGINT',close)
 return {outcome:'SERVICE_READY',mode,address:server.address()}
 }catch(e){await sql?.end({timeout:1});throw e}
}
if(require.main===module){
 let bytes=0;const chunks:Buffer[]=[]
 process.stdin.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>2_000_000){process.stderr.write('CONFIGURATION_TOO_LARGE\n');process.exit(2)}chunks.push(b)})
 process.stdin.on('end',async()=>{try{const c=JSON.parse(Buffer.concat(chunks).toString('utf8'));chunks.length=0;const out=await runR36Operator(c);process.stdout.write(JSON.stringify(out)+'\n')}catch{process.stderr.write('R36_OPERATOR_FAIL_CLOSED\n');process.exitCode=2}})
}
