// Dedicated Pi Testnet operator. Run the issuer and signer as separate services.
// Neither a Next.js route nor the B2 launcher can select this production target.
import postgres from 'postgres'
import { once } from 'node:events'
import { isAbsolute } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { createR36HttpsPorts } from './r36-provider-transport'
import { createR36OperatorService, type R36ServiceConfig } from './r36-operator-service'
import { certifyR36ProductionAdmission } from './r36-successor-registration'
import { createR36LifecycleHandler } from './r36-lifecycle-service'
import type { R36CertificateDatabase } from './r36-certificate-consumer'

import {productionR36Host as databaseHost, productionR36Branch as branchId} from './r36-production-runtime'
const digest = /^[0-9a-f]{64}$/
type Mode = 'issuer' | 'signer'
type ProviderConfig = Parameters<typeof createR36HttpsPorts>[0]
type Config = {
  mode: Mode
  network: 'Pi Testnet'
  databaseUrl: string
  policyDigest: string
  // null selects a persistent service for already-approved requests in one policy.
  // No service may enroll a request or grant itself approval privileges.
  approvalId: string | null
  providers?: ProviderConfig
  service?: R36ServiceConfig
  signingKeyPem?: string
}
type Tx = Parameters<Parameters<R36CertificateDatabase['begin']>[0]>[0]

export function validateProductionConfig(input: unknown): Config {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw Error('CONFIG_REQUIRED')
  const c = input as Config
  if (c.network !== 'Pi Testnet' || (c.mode !== 'issuer' && c.mode !== 'signer')) throw Error('OPERATOR_TARGET')
  const fields = ['mode', 'network', 'databaseUrl', 'policyDigest', 'approvalId',
    ...(c.mode === 'issuer' ? ['providers', ...(c.approvalId === null ? ['service'] : [])] : ['service', 'signingKeyPem'])]
  if (Object.keys(c).length !== fields.length || !fields.every(f => Object.hasOwn(c, f))) throw Error('CONFIG_FIELDS')
  if (typeof c.policyDigest !== 'string' || !digest.test(c.policyDigest) ||
      !(typeof c.approvalId === 'string' && digest.test(c.approvalId) || c.approvalId === null)) throw Error('APPROVAL_ID')
  const url = new URL(c.databaseUrl)
  if (url.protocol !== 'postgresql:' || url.hostname !== databaseHost || (url.port && url.port !== '5432') ||
      url.pathname !== '/neondb' || url.username !== 'r36_' + c.mode || !url.password || url.search || url.hash) throw Error('DATABASE_TARGET')
  if (c.mode === 'issuer') {
    const ports = c.providers
    if (!ports || new URL(ports.evidence.origin).origin === new URL(ports.signer.origin).origin ||
        ports.evidence.serverSpkiSha256 === ports.signer.serverSpkiSha256) throw Error('SERVICES_NOT_SEPARATE')
  } else if (typeof c.signingKeyPem !== 'string' || !c.signingKeyPem) throw Error('SIGNER_CONFIGURATION')
  if ((c.mode === 'signer' || c.approvalId === null) && (!c.service ||
      !['127.0.0.1', '::1'].includes(c.service.host) || !Number.isInteger(c.service.port) ||
      c.service.port < 1 || c.service.port > 65535)) throw Error('SERVICE_CONFIGURATION')
  return c
}

// Validate the actual physical session in each transaction, including reconnects.
export async function checkProductionTransaction(tx: Tx, c: Pick<Config, 'mode' | 'approvalId' | 'policyDigest'>) {
  const rows = await tx.unsafe(`
    SELECT current_database() = 'neondb' AND current_setting('neon.branch_id', true) = $1
       AND session_user::text = $2 AND current_user::text = $2 AS identity_ok,
       r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
       AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
       AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
       AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','r36_signing')
                       AND has_schema_privilege(r.oid,n.oid,'CREATE')) AS restricted,
       NOT EXISTS (
         SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname IN ('public','r36_signing') AND c.relkind IN ('r','p','v','m','f')
           AND (has_table_privilege(r.oid,c.oid,'UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
                OR has_table_privilege(r.oid,c.oid,'INSERT') AND NOT
                    ($2='r36_issuer' AND n.nspname='public' AND c.relname='r36_independent_u2a_attestations')
                OR has_any_column_privilege(r.oid,c.oid,'UPDATE,REFERENCES')
                OR has_any_column_privilege(r.oid,c.oid,'INSERT') AND NOT
                    ($2='r36_issuer' AND n.nspname='public' AND c.relname='r36_independent_u2a_attestations'))
       ) AS acl_ok,
       NOT EXISTS (
         SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
         WHERE (n.nspname='r36_signing' OR n.nspname='public' AND f.proname LIKE 'r36_%')
           AND has_function_privilege(r.oid,f.oid,'EXECUTE')
           AND NOT (
             $2='r36_issuer' AND n.nspname='public' AND
               (f.proname,oidvectortypes(f.proargtypes)) IN
                 (('r36_certificate_context','text'),('r36_record_certificate','text, text, jsonb, text'),('r36_revoke_certificate','text, text'),('r36_register_successor_binding','text'),
                  ('r36_terminal_review_context','text, text, text'),('r36_record_prior_closure','text, text, text, text, text, bigint, bigint'),
                  ('r36_bound_lifecycle_context','text, text'),('r36_record_bound_lifecycle','text, text, text, text, bigint, bigint'),('r36_revoke_prior_closure','text, text'),
                  ('r36_lifecycle_job_receipt','text, text, text, text, text, text'),('r36_observe_owner_policy','text'),('r36_bind_initial_clearance','text'))
             OR $2='r36_signer' AND n.nspname='r36_signing' AND
               (f.proname,oidvectortypes(f.proargtypes)) IN (('context','text'),('record','text, text'))
           )
       ) AS separation_ok
    FROM pg_roles r WHERE r.rolname=current_user`, [branchId, 'r36_'+c.mode])
  if (rows.length !== 1 || !['identity_ok','restricted','acl_ok','separation_ok'].every(k => rows[0][k] === true))
    throw Error('DATABASE_AUTHORITY')
  // Idle services have no request. Every issuer job supplies an exact nonce to
  // this same physical-session check before the original verifier can run.
  if (c.approvalId === null) return
  const sql = c.mode === 'issuer' ? 'SELECT public.r36_certificate_context($1) AS ctx' : 'SELECT r36_signing.context($1) AS ctx'
  const contextRows = await tx.unsafe(sql, [c.approvalId])
  const context = contextRows[0]?.ctx as {policy?:{policyDigest?:string};binding?:{network?:string;nonce?:string};policy_digest?:string;idempotency_key?:string} | null
  if (contextRows.length !== 1 || !context) throw Error('APPROVAL_UNAVAILABLE')
  const matches = c.mode === 'issuer'
    ? context.binding?.network === 'Pi Testnet' && context.binding.nonce === c.approvalId && context.policy?.policyDigest === c.policyDigest
    : context.idempotency_key === c.approvalId && context.policy_digest === c.policyDigest
  if (!matches) throw Error('APPROVAL_SCOPE')
}

/** Constrain every signer transaction, including pooled reconnects and concurrent
 * requests, to exact protected bytes under the configured policy. No caller SQL,
 * request enrollment or cross-policy signing is available through this adapter. */
export function scopeProductionSignerTransaction(tx: Tx, c: Pick<Config,'approvalId'|'policyDigest'>): Tx {
  const policyDigest = c.policyDigest, approvalId = c.approvalId
  if (!digest.test(policyDigest) || !(approvalId === null || typeof approvalId === 'string' && digest.test(approvalId)))
    throw Error('SIGNING_CONFIGURATION')
  let approved: string | null = null
  return {unsafe: async (query, values) => {
    const key = values?.[0]
    if (typeof key !== 'string' || !digest.test(key) ||
        (approvalId !== null && key !== approvalId)) throw Error('SIGNING_REQUEST_SCOPE')
    if (query === 'SELECT r36_signing.context($1) AS context' && values?.length === 1) {
      // A transaction may approve exactly one identity. Concurrent callers get
      // independent adapters and PostgreSQL row locks, never shared mutable state.
      if (approved !== null && approved !== key) throw Error('SIGNING_REQUEST_SCOPE')
      const rows = await tx.unsafe(query, values)
      const context = rows.length === 1 ? rows[0].context as Record<string,unknown> | null : null
      if (!context || context.idempotency_key !== key || context.policy_digest !== policyDigest)
        throw Error('APPROVAL_SCOPE')
      approved = key
      return rows
    }
    if (query === 'SELECT r36_signing.record($1,$2) AS signature' && values?.length === 2 && approved === key)
      return tx.unsafe(query, values)
    throw Error('SIGNING_QUERY_SCOPE')
  }}
}

async function startProtectedService(server:ReturnType<typeof createR36OperatorService>, service:R36ServiceConfig, onClose:()=>void) {
  const ready=once(server,'listening')
  server.listen(service.port,service.host)
  await ready
  const close=()=>server.close()
  process.once('SIGTERM',close)
  process.once('SIGINT',close)
  server.once('close',()=>{process.off('SIGTERM',close);process.off('SIGINT',close);onClose()})
}

export async function runProductionOperator(input: unknown) {
  if (input && typeof input==='object' && 'mode' in input && input.mode==='evidence') {
    const c=input as {mode:'evidence';network?:string;service?:R36ServiceConfig;directory?:string}
    const svc=c.service, directory=c.directory
    if (Object.keys(c).sort().join()!=='directory,mode,network,service' || c.network!=='Pi Testnet' ||
        !svc || !['127.0.0.1','::1'].includes(svc.host) || !Number.isInteger(svc.port) || svc.port<1 || svc.port>65535 ||
        typeof directory!=='string' || !isAbsolute(directory) || await realpath(directory)!==directory ||
        !(await lstat(directory)).isDirectory()) throw Error('EVIDENCE_CONFIGURATION')
    // This service only serves previously published immutable signed artifacts.
    // No DB connection, signing key, evidence generation or financial transport.
    await startProtectedService(createR36OperatorService(svc,{kind:'evidence',directory}),svc,()=>{})
    return {outcome:'EVIDENCE_LISTENING',scope:'DIGEST_BOUND_READ_ONLY'}
  }
  const c = validateProductionConfig(input)
  const url = new URL(c.databaseUrl)
  const sql = postgres({host:databaseHost, database:'neondb', port:5432, username:url.username,
    password:decodeURIComponent(url.password), ssl:{rejectUnauthorized:true,servername:databaseHost},
    // Retain the single TLS connection across the existing 15s reader interval.
    // Identity, ACL and request scope are still checked in every transaction.
    prepare:false, max:1, idle_timeout:30, connect_timeout:8, onnotice:()=>{}})
  const databaseFor = (approvalId:string|null):R36CertificateDatabase => ({
    async begin<T>(run: (tx: Tx)=>Promise<T>): Promise<T> {
      // postgres.js adapts arrays of results. Wrap T to preserve its type.
      const wrapped = await sql.begin(async inner => {
        const tx: Tx = {unsafe: async (query, values) => inner.unsafe(query, values as never)}
        await checkProductionTransaction(tx, {...c,approvalId})
        const scoped: Tx = c.mode === 'issuer' ? tx : scopeProductionSignerTransaction(tx,c)
        return {value: await run(scoped)}
      })
      return wrapped.value as T
    }
  })
  const db=databaseFor(c.approvalId)
  let listening = false
  try {
    if (c.mode === 'issuer') {
      const ports=createR36HttpsPorts(c.providers!)
      if (c.approvalId !== null) return await certifyR36ProductionAdmission(db,c.approvalId,ports)
      await db.begin(async () => undefined)
      const service=c.service!
      const server=createR36OperatorService(service,{kind:'issuer',issue:nonce=>
        certifyR36ProductionAdmission(databaseFor(nonce),nonce,ports),
        lifecycle:createR36LifecycleHandler(databaseFor(null),c.policyDigest,{readEvidence:ports.readEvidence}),
        observeOwnerRegistry:()=>databaseFor(null).begin(async tx=>{
          const rows=await tx.unsafe('SELECT public.r36_observe_owner_policy($1) AS observation',[c.policyDigest])
          return rows.length===1?rows[0].observation:null
        })})
      await startProtectedService(server,service,()=>{void sql.end({timeout:2})})
      listening=true
      return {outcome:'ISSUER_LISTENING',scope:'SINGLE_POLICY_PROTECTED_REQUESTS'}
    }
    await db.begin(async () => undefined)
    const service = c.service!
    const server = createR36OperatorService(service,{kind:'signer',db,signingKeyPem:c.signingKeyPem!})
    await startProtectedService(server,service,()=>{void sql.end({timeout:2})})
    listening = true
    return {outcome:'SIGNER_LISTENING',scope:c.approvalId===null?'SINGLE_POLICY_APPROVED_REQUESTS':'SINGLE_APPROVED_DIGEST'}
  } finally { if (!listening) await sql.end({timeout:2}) }
}

if (require.main === module) {
  void (async () => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const data of process.stdin) {
      const chunk = Buffer.from(data)
      size += chunk.length
      if (size > 2_000_000) throw Error('CONFIGURATION_SIZE')
      chunks.push(chunk)
    }
    const result = await runProductionOperator(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    process.stdout.write(JSON.stringify(result)+'\n')
    if (result.outcome !== 'EVIDENCE_LISTENING' && result.outcome !== 'SIGNER_LISTENING' && result.outcome !== 'ISSUER_LISTENING' && result.outcome !== 'RECORDED' && result.outcome !== 'REPLAYED') process.exitCode=2
  })().catch(()=>{process.stderr.write('R36_PRODUCTION_OPERATOR_BLOCKED\n');process.exitCode=2})
}
