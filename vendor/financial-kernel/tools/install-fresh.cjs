#!/usr/bin/env node
'use strict';
// Provisioning utility only. Never imported by application/runtime processes.
const fs=require('node:fs'),path=require('node:path'),postgres=require('postgres');
const {deployment,verifyDatabaseUrl,verifyDatabaseBinding}=require('../dist/deployment.js');
async function install(){
 const p=deployment(),url=process.env.KERNEL_MIGRATION_DATABASE_URL;
 if(!url)throw Error('MIGRATION_DATABASE_REQUIRED');verifyDatabaseUrl(url);
 const sql=postgres(url,{ssl:{rejectUnauthorized:true,servername:p.databaseHost},max:1,prepare:false,onnotice:()=>{}});
 try{await sql.begin(async tx=>{
  await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended('KERNEL_INSTALL_V1',0))");
  const identity=await tx.unsafe("SELECT current_database() database,current_setting('neon.branch_id',true) branch");
  if(identity[0].database!==p.databaseName||identity[0].branch!==p.databaseBranch)throw Error('MIGRATION_TARGET_MISMATCH');
  if((await tx.unsafe("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','r36_signing','r36_registration') AND c.relkind IN ('r','p','v','m','S') LIMIT 1")).length)throw Error('EMPTY_DATABASE_REQUIRED');
  const role=await tx.unsafe("SELECT rolname FROM pg_roles WHERE rolname LIKE 'r36_%'");
  if(role.length)throw Error('DEDICATED_EMPTY_ROLE_NAMESPACE_REQUIRED');
  if(!(await tx.unsafe("SELECT 1 FROM pg_roles WHERE rolname='neondb_owner'")).length)throw Error('SCHEMA_OWNER_REQUIRED');
  for(const name of ['roles.sql','fresh-schema.sql'])await tx.unsafe(fs.readFileSync(path.join(__dirname,'../sql',name),'utf8'));
  await tx.unsafe(`INSERT INTO public.kernel_deployment_identity(singleton,application_id,profile_sha256,database_branch,recovery_cutover,historical_holds,kernel_version) VALUES(true,$1,$2,$3,$4,$5,$6)`,[p.applicationId,process.env.KERNEL_DEPLOYMENT_SHA256,p.databaseBranch,p.recoveryCutover,p.historicalHolds,require('../package.json').version]);
  await verifyDatabaseBinding(tx);
 });console.log(JSON.stringify({status:'FRESH_SCHEMA_BOUND',applicationId:p.applicationId,kernelVersion:require('../package.json').version,credentialsCreated:false,financialActivation:false}));
 }finally{await sql.end({timeout:2})}
}
if(require.main===module)install().catch(()=>{console.error('INSTALL_FAILED_ROLLED_BACK');process.exitCode=1});module.exports={install};
