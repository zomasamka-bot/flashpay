import {deployment} from '../deployment'
/** Private job entry point, NOT_FOR_DEPLOY until policy/custody/hosting qualification.
 * Read secret configuration from a protected pipe, never arguments or files in artifacts.
 * This accepts authenticated evidence, never a signing key or a financial POST command.
 */
import postgres from 'postgres'
import {checkProductionTransaction} from './r36-production-operator'
import {productionR36Host} from './r36-production-runtime'
import {certifyR36PriorClosure,certifyR36BoundSuccessor} from './r36-wallet-lifecycle'
import type {R36CertificateDatabase} from './r36-certificate-consumer'
type Config={network:'Pi Testnet';databaseUrl:string;policyDigest:string;mode:'prior_closure'|'bound_successor';evidence:unknown;wallet?:string;paymentId?:string;nonce?:string;closureDigest?:string}
export function validateLifecycleConfig(input:unknown):Config{
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('CONFIG_REQUIRED')
 const c=input as Config,fields=['network','databaseUrl','policyDigest','mode','evidence',...(c.mode==='prior_closure'?['wallet','paymentId']:['nonce','closureDigest'])]
 if(!['prior_closure','bound_successor'].includes(c.mode)||c.network!=='Pi Testnet'||Object.keys(c).length!==fields.length||!fields.every(k=>Object.hasOwn(c,k))||
  typeof c.policyDigest!=='string'||!/^[0-9a-f]{64}$/.test(c.policyDigest))throw Error('LIFECYCLE_CONFIG')
 const u=new URL(c.databaseUrl)
 if(u.protocol!=='postgresql:'||u.hostname!==productionR36Host||u.pathname!==('/'+deployment().databaseName)||u.username!=='r36_issuer'||!u.password||u.search||u.hash||(u.port&&u.port!=='5432'))throw Error('LIFECYCLE_TARGET')
 if(c.mode==='prior_closure'&&(!/^G[A-Z2-7]{55}$/.test(c.wallet??'')||!/^[A-Za-z0-9_.:-]{1,128}$/.test(c.paymentId??''))||
  c.mode==='bound_successor'&&(!/^[0-9a-f]{64}$/.test(c.nonce??'')||!/^[0-9a-f]{64}$/.test(c.closureDigest??'')))throw Error('LIFECYCLE_SUBJECT')
 return c
}
export async function runR36LifecycleJob(input:unknown){
 const c=validateLifecycleConfig(input),u=new URL(c.databaseUrl)
 const sql=postgres({host:productionR36Host,port:5432,database:deployment().databaseName,username:'r36_issuer',password:decodeURIComponent(u.password),
  ssl:{rejectUnauthorized:true,servername:productionR36Host},prepare:false,max:1,connect_timeout:8,onnotice:()=>{}})
 const db:R36CertificateDatabase={begin:async fn=>{
  const wrapped=await sql.begin(async q=>{
   const tx={unsafe:async(query:string,values?:unknown[])=>q.unsafe(query,values as never)}
   await checkProductionTransaction(tx,{mode:'issuer',approvalId:null,policyDigest:c.policyDigest})
   const scoped={unsafe:async(query:string,values?:unknown[])=>{
    const reads=['SELECT public.r36_terminal_review_context($1,$2,$3) AS context','SELECT public.r36_bound_lifecycle_context($1,$2) AS context']
    const writes=['SELECT public.r36_record_prior_closure($1,$2,$3,$4,$5,$6,$7) AS outcome','SELECT public.r36_record_bound_lifecycle($1,$2,$3,$4,$5,$6) AS outcome']
    const replay='SELECT public.r36_lifecycle_job_receipt($1,$2,$3,$4,$5,$6) AS receipt'
    if(![...reads,...writes,replay].includes(query))throw Error('LIFECYCLE_QUERY')
    const rows=await tx.unsafe(query,values)
    if(query===replay){const receipt=rows[0]?.receipt as {policyDigest?:string}|null;if(receipt&&receipt.policyDigest!==c.policyDigest)throw Error('LIFECYCLE_POLICY')}
    if(reads.includes(query)){
     const context=rows.length===1?rows[0].context as {policy?:{policy_digest?:string}}|null:null
     if(context&&context.policy?.policy_digest!==c.policyDigest)throw Error('LIFECYCLE_POLICY')
    }
    return rows
   }}
   return {value:await fn(scoped)}
  });return wrapped.value
 }}
 try{return c.mode==='prior_closure'?await certifyR36PriorClosure(db,c.policyDigest,c.wallet!,c.paymentId!,c.evidence):await certifyR36BoundSuccessor(db,c.nonce!,c.closureDigest!,c.evidence)}
 finally{await sql.end({timeout:2})}
}
if(require.main===module)void(async()=>{
 const chunks:Buffer[]=[];let size=0
 for await(const data of process.stdin){const b=Buffer.from(data);size+=b.length;if(size>12_100_000)throw Error('CONFIG_SIZE');chunks.push(b)}
 const result=await runR36LifecycleJob(JSON.parse(Buffer.concat(chunks).toString('utf8')))
 process.stdout.write(JSON.stringify(result)+'\n');if(result.outcome==='BLOCKED')process.exitCode=2
})().catch(()=>{process.stderr.write('R36_LIFECYCLE_JOB_BLOCKED\n');process.exitCode=2})
