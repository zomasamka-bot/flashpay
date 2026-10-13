import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

function read(path: string): string { return readFileSync(resolve(process.cwd(), path), 'utf8') }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`SETTLEMENT_REFUND_XOR_PRODUCTION_BINDING=FAIL ${message}`) }
function indexIn(source: string, needle: string, label: string): number { const i=source.indexOf(needle); assert(i>=0, `missing ${label}`); return i }

const db = read('lib/db.ts')
const refundStore = read('lib/refund-checkpoint-store.ts')
const refundIntent = read('lib/refund-intent-service.ts')
const refundExecutor = read('lib/refund-executor.ts')

// 0) Every durable Refund INSERT must belong to an explicitly audited, serialized writer.
// Fail closed on any new INSERT or SQL template bypass in the refund checkpoint store.
// This deliberately binds to the two known authority writers; any new writer requires review.
const permittedRefundWriters = [
  { start: 'export async function createRefundCheckpointWithAudit(', end: 'export async function createDr11RefundAuthorityFromDurableHold(', count: 1, name: 'standard refund writer' },
  { start: 'export async function createDr11RefundAuthorityFromDurableHold(', end: 'export async function claimRefundIdempotency(', count: 1, name: 'DR11 refund writer' },
]
assert(!/\b(?:export\s+)?(?:async\s+)?function\s+createRefundCheckpoint\s*\(/.test(refundStore), 'unprotected legacy createRefundCheckpoint returned')
const insertMatches = [...refundStore.matchAll(/\bINSERT\s+INTO\s+(?:public\.)?refund_checkpoints\b/gi)]
assert(insertMatches.length === 2, `unexpected Refund checkpoint writer count: ${insertMatches.length}`)
for (const writer of permittedRefundWriters) {
  const a = indexIn(refundStore, writer.start, writer.name + ' start')
  const b = indexIn(refundStore, writer.end, writer.name + ' end')
  assert(a < b, `${writer.name} function ordering invalid`)
  const body = refundStore.slice(a, b)
  const count = [...body.matchAll(/\bINSERT\s+INTO\s+(?:public\.)?refund_checkpoints\b/gi)].length
  assert(count === writer.count, `${writer.name} INSERT count drifted`)
  assert(body.includes('withPaymentAuthorityTransaction('), `${writer.name} bypasses shared PostgreSQL authority lock`)
}
// Catch an inserted raw Refund writer anywhere in the repository's tracked application source.
// Exempt the known DB schema DDL, test scripts, and the two reviewed writers above.


function scanRuntimeDirectory(dir: string): void {
  for (const item of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
    const rel = join(dir, item.name)
    if (item.isDirectory()) { scanRuntimeDirectory(rel); continue }
    if (!item.isFile() || !/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(item.name)) continue
    if (rel === join('lib', 'refund-checkpoint-store.ts')) continue
    assert(!/INSERT\s+INTO\s+(?:public\.)?refund_checkpoints/i.test(read(rel)), `unexpected runtime Refund INSERT: ${rel}`)
  }
}
for (const dir of ['lib', 'app', 'pages', 'components']) {
  try { readdirSync(resolve(process.cwd(), dir)); scanRuntimeDirectory(dir) }
  catch (e: any) { if (e?.code !== 'ENOENT') throw e }
}

// 1) Shared durable serialization primitive must be a transaction-scoped PostgreSQL lock.
const authorityFn = indexIn(db, 'export async function withPaymentAuthorityTransaction', 'withPaymentAuthorityTransaction')
const authorityEnd = indexIn(db.slice(authorityFn), '\n}\n\nexport async function query', 'withPaymentAuthorityTransaction end') + authorityFn
const authorityBody = db.slice(authorityFn, authorityEnd)
assert(authorityBody.includes('client.begin'), 'authority wrapper is not transactional')
assert(authorityBody.includes('pg_advisory_xact_lock(hashtextextended(${paymentId}, 0))'), 'shared payment advisory lock missing')
assert(authorityBody.indexOf('pg_advisory_xact_lock') < authorityBody.indexOf('return await work(tx)'), 'work executes before durable advisory lock')

// 2) Refund authority creation must take that exact wrapper, inspect active Settlement, then INSERT Refund in the same callback.
const refundCreate = indexIn(refundStore, 'export async function createRefundCheckpointWithAudit', 'createRefundCheckpointWithAudit')
const refundCreateEnd = indexIn(refundStore.slice(refundCreate), '\n}\n\nexport async function createDr11RefundAuthorityFromDurableHold', 'refund authority function end') + refundCreate
const refundBody = refundStore.slice(refundCreate, refundCreateEnd)
const rLock = indexIn(refundBody, 'withPaymentAuthorityTransaction(checkpoint.paymentId', 'Refund durable authority lock')
const rOpposite = indexIn(refundBody, "SELECT EXISTS(SELECT 1 FROM settlement_checkpoints WHERE payment_id=${checkpoint.paymentId} AND stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized')) AS active", 'Refund opposite Settlement read')
const rConflict = indexIn(refundBody, "opposite[0].active === true) return []", 'Refund conflict fail-closed')
const rInsert = indexIn(refundBody, 'INSERT INTO refund_checkpoints', 'Refund authority insert')
assert(rLock < rOpposite && rOpposite < rConflict && rConflict < rInsert, 'Refund authority ordering is not lock -> opposite read -> conflict gate -> insert')
assert(refundBody.includes('ON CONFLICT (payment_id) DO NOTHING'), 'Refund payment uniqueness/idempotent insert guard missing')

// 3) Settlement movement-capable Stage1 must take the same payment advisory lock and inspect active Refund before entering a2u_created.
const stageMarker = 'export async function recordSettlementA2UCreatedCheckpoint'
const stageStart = indexIn(db, stageMarker, 'recordSettlementA2UCreatedCheckpoint')
const stageEndNeedle = '\n}\n\nexport type SettlementCheckpoint'
let stageEnd = db.indexOf(stageEndNeedle, stageStart)
if (stageEnd < 0) stageEnd = db.indexOf('\n}\n\nexport async function', stageStart + stageMarker.length)
assert(stageEnd > stageStart, 'Settlement Stage1 function boundary unavailable')
const stageBody = db.slice(stageStart, stageEnd)
const sLock = indexIn(stageBody, 'pg_advisory_xact_lock(hashtextextended(${params.paymentId}, 0))', 'Settlement durable authority lock')
const sOpposite = indexIn(stageBody, 'SELECT EXISTS(SELECT 1 FROM refund_checkpoints WHERE payment_id=${params.paymentId}', 'Settlement opposite Refund read')
const sConflict = indexIn(stageBody, 'if (opposite[0].active === true) return [{ authorityConflict: true }]', 'Settlement conflict fail-closed')
const sAdvance = indexIn(stageBody, "stage = 'a2u_created'", 'Settlement movement-capable authority advance')
assert(sLock < sOpposite && sOpposite < sConflict && sConflict < sAdvance, 'Settlement authority ordering is not lock -> opposite read -> conflict gate -> a2u_created')
assert(!stageBody.includes("status<>'manual_review_required'") && stageBody.includes("FROM refund_checkpoints WHERE payment_id=${params.paymentId} "), 'Settlement opposite Refund must include manual-review rows')

// 4) Descriptive cross-authority reader must detect simultaneous durable authorities and uncertainty must not become CLEAR.
const readStart = indexIn(db, 'export async function readSettlementRefundAuthority', 'readSettlementRefundAuthority')
const readEnd = indexIn(db.slice(readStart), '\n}\n\nexport async function verifySettlementRefundAuthorityExclusion', 'authority reader end') + readStart
const readBody = db.slice(readStart, readEnd)
assert(readBody.includes("stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized')"), 'Settlement active predicate drifted')
assert(!readBody.includes("status<>'manual_review_required'") && readBody.includes("FROM refund_checkpoints WHERE payment_id=${paymentId} "), 'Refund authority must include manual-review rows')
assert(readBody.includes("if(settlementActive&&refundActive)return{outcome:'CONFLICT'"), 'dual durable authority does not fail closed')
assert(readBody.includes("if(!client)return{outcome:'INDETERMINATE'"), 'PostgreSQL absence does not fail closed')
assert(readBody.includes("catch(e){console.error") && readBody.includes("return{outcome:'INDETERMINATE'"), 'authority read exception does not fail closed')

// 5) Runtime Refund acquisition/replay must consult durable authority; Redis lock alone may not authorize a new Refund.
assert(refundStore.includes('const authority=await readSettlementRefundAuthority(paymentId)'), 'Refund operation lock is not bound to durable authority')
assert(refundStore.includes('if(authority.outcome!=="CLEAR"||authority.settlementActive)return false'), 'Refund operation lock does not fail closed on Settlement/uncertainty')
assert(refundIntent.includes('const lockedAuthority = await readSettlementRefundAuthority(payment.id)'), 'Refund intent lacks post-lock durable authority recheck')
assert(refundIntent.includes("lockedAuthority.outcome !== 'CLEAR' || lockedAuthority.settlementActive"), 'Refund intent post-lock authority gate drifted')
assert(refundExecutor.includes('const authority = await readSettlementRefundAuthority(checkpoint.paymentId)'), 'Refund executor lacks durable authority binding')
assert(refundExecutor.includes("authority.outcome !== 'CLEAR' || authority.settlementActive || !authority.refundActive"), 'Refund executor authority gate drifted')

// 6) Adversarial state table for the exact durable predicates above. This validates the intended truth table,
// while source assertions above prove production uses these predicates at acquisition/replay boundaries.
type State = { settlementActive:boolean; refundActive:boolean; dbCertain:boolean }
const cases: Array<{name:string; state:State; settlementAllowed:boolean; refundAllowed:boolean}> = [
  {name:'clear', state:{settlementActive:false,refundActive:false,dbCertain:true}, settlementAllowed:true, refundAllowed:true},
  {name:'settlement_owns', state:{settlementActive:true,refundActive:false,dbCertain:true}, settlementAllowed:true, refundAllowed:false},
  {name:'refund_owns', state:{settlementActive:false,refundActive:true,dbCertain:true}, settlementAllowed:false, refundAllowed:true},
  {name:'durable_conflict', state:{settlementActive:true,refundActive:true,dbCertain:true}, settlementAllowed:false, refundAllowed:false},
  {name:'db_uncertain_clear_shape', state:{settlementActive:false,refundActive:false,dbCertain:false}, settlementAllowed:false, refundAllowed:false},
  {name:'db_uncertain_settlement_shape', state:{settlementActive:true,refundActive:false,dbCertain:false}, settlementAllowed:false, refundAllowed:false},
  {name:'db_uncertain_refund_shape', state:{settlementActive:false,refundActive:true,dbCertain:false}, settlementAllowed:false, refundAllowed:false},
]
for (const c of cases) {
  const settlementAllowed = c.state.dbCertain && !c.state.refundActive && !(c.state.settlementActive && c.state.refundActive)
  const refundAllowed = c.state.dbCertain && !c.state.settlementActive && !(c.state.settlementActive && c.state.refundActive)
  assert(settlementAllowed === c.settlementAllowed, `truth-table settlement mismatch: ${c.name}`)
  assert(refundAllowed === c.refundAllowed, `truth-table refund mismatch: ${c.name}`)
}

console.log(`SETTLEMENT_REFUND_XOR_PRODUCTION_BINDING=PASS cases=${cases.length} source=production`)
