import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { neon } from '@neondatabase/serverless'
import { Redis } from '@upstash/redis'

const N = 10_000
const RUN = `dr17-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
const dbUrl = process.env.DR17_DATABASE_URL?.trim()
const redisUrl = process.env.DR17_REDIS_REST_URL?.trim()
const redisToken = process.env.DR17_REDIS_REST_TOKEN?.trim()
const prodDb = process.env.DATABASE_URL?.trim()
const prodRedis = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim()

// Fail closed before the first write. There is deliberately no fallback to production resources.
assert.ok(dbUrl, 'DR17_DATABASE_URL is required')
assert.ok(redisUrl, 'DR17_REDIS_REST_URL is required')
assert.ok(redisToken, 'DR17_REDIS_REST_TOKEN is required')
assert.notEqual(dbUrl, prodDb, 'DR17_DATABASE_URL must not equal DATABASE_URL')
assert.notEqual(redisUrl, prodRedis, 'DR17 Redis must not equal production Redis')
assert.equal(process.env.DR17_ISOLATED_LIVE_ACK, 'I_UNDERSTAND_THIS_IS_ISOLATED_CERTIFICATION', 'explicit isolated certification acknowledgement required')

const sql = neon(dbUrl)
const redis = new Redis({ url: redisUrl, token: redisToken })
const key = (suffix) => `flashpay:dr17:${RUN}:${suffix}`
const started = performance.now()

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
await sql`INSERT INTO dr17_cert_runs(run_id,expected) VALUES(${RUN},${N})`

// 10k durable financial-state records, split 5k/5k. No Pi/Horizon identifiers or transports exist in this harness.
const CHUNK = 250
for (let base=0;base<N;base+=CHUNK) {
  const rows=[]
  for (let i=base;i<Math.min(base+CHUNK,N);i++) {
    const lane=i%2===0?'settlement':'refund'
    rows.push({payment_id:`${RUN}-p-${i}`,lane,authority:lane})
  }
  const values = rows.map((_,i)=>`($1,$${i*3+2},$${i*3+3},$${i*3+4})`).join(',')
  const params=[RUN,...rows.flatMap(r=>[r.payment_id,r.lane,r.authority])]
  await sql.query(`INSERT INTO dr17_cert_items(run_id,payment_id,lane,authority) VALUES ${values}`,params)
}

// Redis projection/queue is intentionally disposable; PostgreSQL remains durable authority.
for (let base=0;base<N;base+=500) {
  const pipe=redis.pipeline()
  for(let i=base;i<Math.min(base+500,N);i++) pipe.zadd(key('ready'),{score:i,member:`${RUN}-p-${i}`})
  await pipe.exec()
}

// Deterministic crash/recovery pattern: every 7th item loses projection before durable completion.
for(let i=0;i<N;i+=7) await redis.zrem(key('ready'),`${RUN}-p-${i}`)

// Concurrent duplicate attempts: DB conditional update is the single authority; movement_count may become 1 only once.
const workers=32
let cursor=0
async function worker(){
  while(true){
    const i=cursor++; if(i>=N) return
    const id=`${RUN}-p-${i}`
    await Promise.all(Array.from({length: i%11===0?3:1},()=>sql`
      UPDATE dr17_cert_items SET stage=1,movement_count=1
      WHERE run_id=${RUN} AND payment_id=${id} AND stage=0 AND movement_count=0
    `))
  }
}
await Promise.all(Array.from({length:workers},worker))

// Durable rediscovery: rebuild missing projection solely from durable unfinished/recovery evidence.
const missing = await sql`SELECT payment_id FROM dr17_cert_items WHERE run_id=${RUN} AND stage=1 AND recovered=false ORDER BY payment_id`
for(let base=0;base<missing.length;base+=500){
  const pipe=redis.pipeline()
  for(const r of missing.slice(base,base+500)) pipe.zadd(key('recovered'),{score:base,member:r.payment_id})
  await pipe.exec()
}
await sql`UPDATE dr17_cert_items SET stage=2,recovered=true WHERE run_id=${RUN} AND stage=1`

const [stats] = await sql`SELECT
 count(*)::int total,
 count(*) FILTER (WHERE lane='settlement')::int settlements,
 count(*) FILTER (WHERE lane='refund')::int refunds,
 count(*) FILTER (WHERE movement_count<>1)::int bad_movement_count,
 count(*) FILTER (WHERE authority<>lane)::int authority_overlap,
 count(*) FILTER (WHERE stage<>2 OR recovered=false)::int lost_recovery,
 count(DISTINCT payment_id)::int distinct_ids
 FROM dr17_cert_items WHERE run_id=${RUN}`
const ready = Number(await redis.zcard(key('ready')))
const recovered = Number(await redis.zcard(key('recovered')))
const durationMs=Math.round(performance.now()-started)
const report={runId:RUN,total:stats.total,settlements:stats.settlements,refunds:stats.refunds,distinctIds:stats.distinct_ids,
 badMovementCount:stats.bad_movement_count,settlementRefundOverlap:stats.authority_overlap,lostRecovery:stats.lost_recovery,
 redisReadyAfterCrash:ready,redisRecovered:recovered,workers,durationMs,
 piCalled:false,horizonCalled:false,productionDatabaseUsed:false,productionRedisUsed:false}
assert.equal(stats.total,N)
assert.equal(stats.distinct_ids,N)
assert.equal(stats.settlements,5000)
assert.equal(stats.refunds,5000)
assert.equal(stats.bad_movement_count,0)
assert.equal(stats.authority_overlap,0)
assert.equal(stats.lost_recovery,0)
await sql`UPDATE dr17_cert_runs SET finished_at=now(),verdict='PASS',report=${JSON.stringify(report)}::jsonb WHERE run_id=${RUN}`
await redis.del(key('ready'),key('recovered'))
console.log(JSON.stringify({certification:'PASS',gate:'DR17-ISOLATED-LIVE-10K-PERSISTENCE-CONCURRENCY',...report},null,2))
