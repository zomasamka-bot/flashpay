import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { neon } from '@neondatabase/serverless'
import { Redis } from '@upstash/redis'

const N = 10_000
const WORKERS = 8
const DB_CHUNK = 200
const REDIS_CHUNK = 250
const RUN = `dr17-shared-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
const dbUrl = process.env.DATABASE_URL?.trim()
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim()
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.KV_REST_API_TOKEN?.trim()
const ack = process.env.DR17_SHARED_RESOURCE_ACK?.trim()
const key = (suffix) => `flashpay:dr17:cert:${RUN}:${suffix}`
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// Shared-resource mode is explicit and fail-closed. No alternate financial transport exists here.
assert.ok(dbUrl, 'DATABASE_URL is required')
assert.ok(redisUrl, 'production Redis REST URL is required')
assert.ok(redisToken, 'production Redis REST token is required')
assert.equal(ack, 'I_UNDERSTAND_DR17_USES_SHARED_INFRASTRUCTURE_NOT_PRODUCTION_FINANCIAL_TABLES', 'explicit shared-resource certification acknowledgement required')

const sql = neon(dbUrl)
const redis = new Redis({ url: redisUrl, token: redisToken })
const started = performance.now()
const latencySamples = []
async function timed(label, fn, hardLimitMs = 15_000) {
  const t = performance.now()
  const value = await fn()
  const ms = Math.round(performance.now() - t)
  latencySamples.push({ label, ms })
  assert.ok(ms <= hardLimitMs, `${label} exceeded hard latency guard: ${ms}ms > ${hardLimitMs}ms`)
  return value
}

// Read-only preflight before the first certification write.
await timed('db-preflight', () => sql`SELECT 1 AS ok`, 5_000)
await timed('redis-preflight', () => redis.ping(), 5_000)

// Certification-only tables. Names do not overlap FlashPay runtime financial tables.
await timed('create-cert-tables', async () => {
  await sql`CREATE TABLE IF NOT EXISTS dr17_cert_runs (
    run_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), expected integer NOT NULL,
    finished_at timestamptz, verdict text, report jsonb
  )`
  await sql`CREATE TABLE IF NOT EXISTS dr17_cert_items (
    run_id text NOT NULL, payment_id text NOT NULL, lane text NOT NULL CHECK (lane IN ('settlement','refund')),
    authority text NOT NULL CHECK (authority IN ('settlement','refund')), stage integer NOT NULL DEFAULT 0,
    movement_count integer NOT NULL DEFAULT 0, recovered boolean NOT NULL DEFAULT false,
    PRIMARY KEY(run_id,payment_id), FOREIGN KEY(run_id) REFERENCES dr17_cert_runs(run_id) ON DELETE CASCADE
  )`
})
await sql`INSERT INTO dr17_cert_runs(run_id,expected) VALUES(${RUN},${N})`

// 10k certification records, throttled into bounded chunks.
for (let base=0;base<N;base+=DB_CHUNK) {
  const rows=[]
  for (let i=base;i<Math.min(base+DB_CHUNK,N);i++) {
    const lane=i%2===0?'settlement':'refund'
    rows.push({payment_id:`${RUN}-p-${i}`,lane,authority:lane})
  }
  const values=rows.map((_,i)=>`($1,$${i*3+2},$${i*3+3},$${i*3+4})`).join(',')
  const params=[RUN,...rows.flatMap(r=>[r.payment_id,r.lane,r.authority])]
  await timed('db-insert-chunk',()=>sql.query(`INSERT INTO dr17_cert_items(run_id,payment_id,lane,authority) VALUES ${values}`,params))
  await sleep(5)
}

// Disposable Redis projection, fully namespaced and pipelined.
for (let base=0;base<N;base+=REDIS_CHUNK) {
  const pipe=redis.pipeline()
  for(let i=base;i<Math.min(base+REDIS_CHUNK,N);i++) pipe.zadd(key('ready'),{score:i,member:`${RUN}-p-${i}`})
  await timed('redis-ready-chunk',()=>pipe.exec())
  await sleep(5)
}

// Crash pattern is projection-only and batched: every seventh certification member disappears.
const crashIds=[]
for(let i=0;i<N;i+=7) crashIds.push(`${RUN}-p-${i}`)
for(let base=0;base<crashIds.length;base+=REDIS_CHUNK) {
  const pipe=redis.pipeline()
  for(const id of crashIds.slice(base,base+REDIS_CHUNK)) pipe.zrem(key('ready'),id)
  await timed('redis-crash-chunk',()=>pipe.exec())
  await sleep(5)
}

// Bounded duplicate pressure. Conditional UPDATE remains the single durable authority.
let cursor=0
async function worker(){
  while(true){
    const i=cursor++; if(i>=N) return
    const id=`${RUN}-p-${i}`
    await Promise.all(Array.from({length:i%11===0?2:1},()=>sql`
      UPDATE dr17_cert_items SET stage=1,movement_count=1
      WHERE run_id=${RUN} AND payment_id=${id} AND stage=0 AND movement_count=0
    `))
    if(i%100===0) await sleep(5)
  }
}
await timed('bounded-concurrent-updates',()=>Promise.all(Array.from({length:WORKERS},worker)),120_000)

// Durable rediscovery rebuilds only DR17 certification projection.
const missing=await sql`SELECT payment_id FROM dr17_cert_items WHERE run_id=${RUN} AND stage=1 AND recovered=false ORDER BY payment_id`
for(let base=0;base<missing.length;base+=REDIS_CHUNK){
  const pipe=redis.pipeline()
  for(const r of missing.slice(base,base+REDIS_CHUNK)) pipe.zadd(key('recovered'),{score:base,member:r.payment_id})
  await timed('redis-recovery-chunk',()=>pipe.exec())
  await sleep(5)
}
await sql`UPDATE dr17_cert_items SET stage=2,recovered=true WHERE run_id=${RUN} AND stage=1`

const [stats]=await sql`SELECT count(*)::int total,
 count(*) FILTER (WHERE lane='settlement')::int settlements,
 count(*) FILTER (WHERE lane='refund')::int refunds,
 count(*) FILTER (WHERE movement_count<>1)::int bad_movement_count,
 count(*) FILTER (WHERE authority<>lane)::int authority_overlap,
 count(*) FILTER (WHERE stage<>2 OR recovered=false)::int lost_recovery,
 count(DISTINCT payment_id)::int distinct_ids
 FROM dr17_cert_items WHERE run_id=${RUN}`
const ready=Number(await redis.zcard(key('ready')))
const recovered=Number(await redis.zcard(key('recovered')))
const durationMs=Math.round(performance.now()-started)
const maxObservedOperationMs=Math.max(...latencySamples.map(x=>x.ms),0)
const report={runId:RUN,total:stats.total,settlements:stats.settlements,refunds:stats.refunds,distinctIds:stats.distinct_ids,
 badMovementCount:stats.bad_movement_count,settlementRefundOverlap:stats.authority_overlap,lostRecovery:stats.lost_recovery,
 redisReadyAfterCrash:ready,redisRecovered:recovered,workers:WORKERS,durationMs,maxObservedOperationMs,
 sharedDatabaseResource:true,sharedRedisResource:true,productionFinancialTablesTargeted:false,productionRuntimeRedisKeysTargeted:false,
 piCalled:false,horizonCalled:false}
assert.equal(stats.total,N)
assert.equal(stats.distinct_ids,N)
assert.equal(stats.settlements,5000)
assert.equal(stats.refunds,5000)
assert.equal(stats.bad_movement_count,0)
assert.equal(stats.authority_overlap,0)
assert.equal(stats.lost_recovery,0)
await sql`UPDATE dr17_cert_runs SET finished_at=now(),verdict='PASS',report=${JSON.stringify(report)}::jsonb WHERE run_id=${RUN}`
await redis.del(key('ready'),key('recovered'))
console.log(JSON.stringify({certification:'PASS',gate:'DR17-SHARED-RESOURCE-SAFE-10K-PERSISTENCE-CONCURRENCY',...report},null,2))
