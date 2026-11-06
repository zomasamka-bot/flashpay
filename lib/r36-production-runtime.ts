import postgres from 'postgres'
import {checkR36RuntimeAcl} from './r36-runtime-acl'

export const productionR36Host = 'ep-falling-bonus-albeetu0.c-3.eu-central-1.aws.neon.tech'
export const productionR36Branch = 'br-tiny-mode-aliatv40'

// Keep the restricted claim and its identity check on the same physical connection.
export async function openProductionR36Runtime(runtimeUrl: string, primaryUrl: string | undefined) {
  const u = new URL(runtimeUrl), primary = new URL(primaryUrl ?? '')
  if (u.protocol !== 'postgresql:' || u.hostname !== productionR36Host || u.pathname !== '/neondb' ||
      (u.port && u.port !== '5432') || u.username !== 'r36_runtime' || !u.password || u.hash ||
      [...u.searchParams].some(([k,v]) => k !== 'sslmode' || !['require','verify-full'].includes(v)) ||
      primary.hostname.replace('-pooler.', '.') !== productionR36Host || primary.pathname !== '/neondb') {
    throw Error('R36_PRODUCTION_TARGET')
  }
  const client = postgres({host:productionR36Host, database:'neondb', username:'r36_runtime',
    password:decodeURIComponent(u.password), port:5432, ssl:{rejectUnauthorized:true,servername:productionR36Host},
    max:2, prepare:false, connect_timeout:8, onnotice:()=>{}})
  async function begin<T>(run:(tx:postgres.TransactionSql) => Promise<T>):Promise<T> {
    const wrapped = await client.begin(async tx => {
      const rows = await tx.unsafe(`
        SELECT current_setting('neon.branch_id',true)=$1 AND current_database()='neondb'
              AND current_user='r36_runtime' AND session_user=current_user AS identity_ok,
          rolcanlogin AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
          AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
          AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
          AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','r36_signing')
                         AND has_schema_privilege(r.oid,n.oid,'CREATE')) AS restricted
        FROM pg_roles r WHERE r.rolname=current_user`,[productionR36Branch])
      if (rows.length !== 1 || rows[0].identity_ok !== true || rows[0].restricted !== true) throw Error('R36_RUNTIME_IDENTITY')
      if (!await checkR36RuntimeAcl({unsafe:async(query,values)=>tx.unsafe(query,values as never)}))
        throw Error('R36_RUNTIME_ACL')
      return {value:await run(tx)}
    })
    return wrapped.value
  }
  try {
    await begin(async () => null)
    return {begin,unsafe:(sql:string,values:unknown[]=[])=>begin(async tx=>tx.unsafe(sql,values as never))}
  } catch (e) { await client.end({timeout:1});throw e }
}
