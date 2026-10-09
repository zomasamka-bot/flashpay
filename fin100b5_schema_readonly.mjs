// FLASHpay FIN-100B.5: metadata-only PostgreSQL inspection; no data reads/writes.
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'

loadEnvConfig(process.cwd())
if (!process.env.DATABASE_URL) {
  console.error('FIN100B5=BLOCKED reason=DATABASE_URL_missing')
  process.exitCode = 2
} else {
  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 5,
    prepare: false,
    onnotice: () => {},
  })
  try {
    const result = await sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`
      await tx`SET LOCAL statement_timeout = '5000ms'`
      const objects = await tx`
        SELECT table_schema, table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_name IN ('settlement_checkpoints', 'payment_create_intents')
        ORDER BY table_schema, table_name, ordinal_position
      `
      const constraints = await tx`
        SELECT ns.nspname AS schema_name, cls.relname AS table_name,
               con.conname AS constraint_name, con.contype AS constraint_type,
               pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class cls ON cls.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
          AND cls.relname IN ('settlement_checkpoints', 'payment_create_intents')
        ORDER BY ns.nspname, cls.relname, con.conname
      `
      const indexes = await tx`
        SELECT schemaname, tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
          AND tablename IN ('settlement_checkpoints', 'payment_create_intents')
        ORDER BY schemaname, tablename, indexname
      `
      return { objects, constraints, indexes }
    })
    console.log('FIN100B5=READ_ONLY_METADATA_COMPLETE')
    console.log(JSON.stringify(result, null, 2))
  } catch (err) {
    console.error('FIN100B5=FAILED', String(err?.code || 'UNKNOWN'), String(err?.message || 'metadata query failed').replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_CONNECTION]'))
    process.exitCode = 1
  } finally {
    await sql.end({ timeout: 3 })
  }
}
