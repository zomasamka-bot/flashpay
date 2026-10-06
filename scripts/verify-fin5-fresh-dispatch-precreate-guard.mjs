import { readFileSync } from 'node:fs'

const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8')
const executor = readFileSync(new URL('../lib/a2u-executor.ts', import.meta.url), 'utf8')

const must = (condition, message) => { if (!condition) throw new Error(`FIN5_PRECREATE_GUARD_FAIL: ${message}`) }

must(db.includes("a2u_create_guard_version TEXT"), 'guard generation column missing')
must(db.includes("a2u_create_attempted_at TIMESTAMP"), 'durable attempt timestamp missing')
must(db.includes("0, 'fin5_v1'"), 'new payment identities are not born guarded')
must(db.includes('export async function claimSettlementA2UCreateAttempt'), 'durable attempt claim missing')
must(db.includes("AND a2u_create_guard_version='fin5_v1'"), 'claim does not reject legacy rows')
must(db.includes('AND a2u_create_attempted_at IS NULL'), 'claim is not one-shot')
must(db.includes("SELECT pg_advisory_xact_lock(hashtextextended(${params.paymentId}, 0))"), 'claim lacks PostgreSQL payment serialization')
must(db.includes("SELECT EXISTS(SELECT 1 FROM refund_checkpoints WHERE payment_id=${params.paymentId} AND status<>'manual_review_required') AS active"), 'claim lacks durable Refund exclusion')
must(executor.includes('const createAttempt = await claimSettlementA2UCreateAttempt({'), 'Stage1 does not claim durable create authority')
const claimAt = executor.indexOf('const createAttempt = await claimSettlementA2UCreateAttempt({')
const postAt = executor.indexOf('fetch("https://api.minepi.com/v2/payments", {', claimAt)
must(claimAt >= 0 && postAt > claimAt, 'Pi POST is not downstream of durable claim')
must(executor.slice(claimAt, postAt).includes('createAttempt.outcome !== "RECORDED"'), 'non-recorded claim does not fail closed before POST')

console.log('FIN5_FRESH_DISPATCH_PRECREATE_GUARD=PASS')
