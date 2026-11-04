// Dedicated Pi Testnet operator. Run the issuer and signer as separate services.
// Neither a Next.js route nor the B2 launcher can select this production target.
import postgres from 'postgres'
import { once } from 'node:events'
import { isAbsolute } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { createR36HttpsPorts } from './r36-provider-transport'
import { createR36OperatorService, type R36ServiceConfig } from './r36-operator-service'
import { certifyR36PreparedAdmission } from './r36-trusted-certification-gate'
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
  approvalId: string  // issuer nonce or signer idempotency key
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
    ...(c.mode === 'issuer' ? ['providers'] : ['service', 'signingKeyPem'])]
  if (Object.keys(c).length !== fields.length || !fields.every(f => Object.hasOwn(c, f))) throw Error('CONFIG_FIELDS')
  if (typeof c.policyDigest !== 'string' || !digest.test(c.policyDigest) ||
      typeof c.approvalId !== 'string' || !digest.test(c.approvalId)) throw Error('APPROVAL_ID')
  const url = new URL(c.databaseUrl)
  if (url.protocol !== 'postgresql:' || url.hostname !== databaseHost || (url.port && url.port !== '5432') ||
      url.pathname !== '/neondb' || url.username !== 'r36_' + c.mode || !url.password || url.search || url.hash) throw Error('DATABASE_TARGET')
  if (c.mode === 'issuer') {
    const ports = c.providers
    if (!ports || new URL(ports.evidence.origin).origin === new URL(ports.signer.origin).origin ||
        ports.evidence.serverSpkiSha256 === ports.signer.serverSpkiSha256) throw Error('SERVICES_NOT_SEPARATE')
  } else if (!c.service || !['127.0.0.1', '::1'].includes(c.service.host) ||
             !Number.isInteger(c.service.port) || c.service.port < 1 || c.service.port > 65535 ||
             typeof c.signingKeyPem !== 'string' || !c.signingKeyPem) throw Error('SIGNER_CONFIGURATION')
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
                 (('r36_certificate_context','text'),('r36_record_certificate','text, text, jsonb, text'),('r36_revoke_certificate','text, text'))
             OR $2='r36_signer' AND n.nspname='r36_signing' AND
               (f.proname,oidvectortypes(f.proargtypes)) IN (('context','text'),('record','text, text'))
           )
       ) AS separation_ok
    FROM pg_roles r WHERE r.rolname=current_user`, [branchId, 'r36_'+c.mode])
  if (rows.length !== 1 || !['identity_ok','restricted','acl_ok','separation_ok'].every(k => rows[0][k] === true))
    throw Error('DATABASE_AUTHORITY')
  const sql = c.mode === 'issuer' ? 'SELECT public.r36_certificate_context($1) AS ctx' : 'SELECT r36_signing.context($1) AS ctx'
  const contextRows = await tx.unsafe(sql, [c.approvalId])
  const context = contextRows[0]?.ctx as {policy?:{policyDigest?:string};binding?:{network?:string;nonce?:string};policy_digest?:string;idempotency_key?:string} | null
  if (contextRows.length !== 1 || !context) throw Error('APPROVAL_UNAVAILABLE')
  const matches = c.mode === 'issuer'
    ? context.binding?.network === 'Pi Testnet' && context.binding.nonce === c.approvalId && context.policy?.policyDigest === c.policyDigest
    : context.idempotency_key === c.approvalId && context.policy_digest === c.policyDigest
  if (!matches) throw Error('APPROVAL_SCOPE')
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
    prepare:false, max:1, idle_timeout:10, connect_timeout:8, onnotice:()=>{}})
  const db: R36CertificateDatabase = {
    async begin<T>(run: (tx: Tx)=>Promise<T>): Promise<T> {
      // postgres.js adapts arrays of results. Wrap T to preserve its type.
      const wrapped = await sql.begin(async inner => {
        const tx: Tx = {unsafe: async (query, values) => inner.unsafe(query, values as never)}
        await checkProductionTransaction(tx, c)
        const scoped: Tx = c.mode === 'issuer' ? tx : {unsafe: async (query, values) => {
          if (values?.[0] !== c.approvalId) throw Error('SIGNING_REQUEST_SCOPE')
          return tx.unsafe(query, values)
        }}
        return {value: await run(scoped)}
      })
      return wrapped.value as T
    }
  }
  let listening = false
  try {
    if (c.mode === 'issuer') return await certifyR36PreparedAdmission(db,c.approvalId,createR36HttpsPorts(c.providers!))
    await db.begin(async () => undefined)
    const service = c.service!
    const server = createR36OperatorService(service,{kind:'signer',db,signingKeyPem:c.signingKeyPem!})
    await startProtectedService(server,service,()=>{void sql.end({timeout:2})})
    listening = true
    return {outcome:'SIGNER_LISTENING',scope:'SINGLE_APPROVED_DIGEST'}
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
    if (result.outcome !== 'EVIDENCE_LISTENING' && result.outcome !== 'SIGNER_LISTENING' && result.outcome !== 'RECORDED' && result.outcome !== 'REPLAYED') process.exitCode=2
  })().catch(()=>{process.stderr.write('R36_PRODUCTION_OPERATOR_BLOCKED\n');process.exitCode=2})
}
