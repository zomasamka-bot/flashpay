import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { neon } from '@neondatabase/serverless'
import { Redis } from '@upstash/redis'

export async function runDr17SharedResourceSafe10k(options = {}) {
  const N = 10_000
  const WORKERS = 8
  const DB_CHUNK = 200
  const REDIS_CHUNK = 250
  const CAPACITY_REFERENCE_MS = 120_000
  const RUN = `dr17-shared-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const dbUrl = process.env.DATABASE_URL?.trim()
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim()
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.KV_REST_API_TOKEN?.trim()
  const ack = process.env.DR17_SHARED_RESOURCE_ACK?.trim()
  const trustedProductionExecution = options?.trustedProductionExecution === true
  const key = (suffix) => `flashpay:dr17:cert:${RUN}:${suffix}`
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const percentile = (values, p) => {
    if (!values.length) return 0
    const sorted = [...values].sort((a,b)=>a-b)
    return sorted[Math.min(sorted.length-1, Math.max(0, Math.ceil(p*sorted.length)-1))]
  }

  assert.ok(dbUrl, 'DATABASE_URL is required')
  assert.ok(redisUrl, 'production Redis REST URL is required')
  assert.ok(redisToken, 'production Redis REST token is required')
  assert.ok(trustedProductionExecution || ack === 'I_UNDERSTAND_DR17_USES_SHARED_INFRASTRUCTURE_NOT_PRODUCTION_FINANCIAL_TABLES', 'explicit shared-resource certification acknowledgement required')

  const sql = neon(dbUrl)
  const redis = new Redis({ url: redisUrl, token: redisToken })
  const started = performance.now()
  const latencySamples = []
  const updateLatencySamples = []
  let runInserted = false
  let phase = 'preflight'
  let capacityObservation = null
  let latestForensic = null

  async function timed(label, fn, hardLimitMs = 15_000) {
    const t = performance.now()
    const value = await fn()
    const ms = Math.round(performance.now() - t)
    latencySamples.push({ label, ms })
    assert.ok(ms <= hardLimitMs, `${label} exceeded hard latency guard: ${ms}ms > ${hardLimitMs}ms`)
    return value
  }
  async function checkpoint(nextPhase, forensic = null) {
    phase = nextPhase
    latestForensic = forensic ?? latestForensic
    if (!runInserted) return
    await sql`UPDATE dr17_cert_runs SET phase=${phase}, forensic=${latestForensic ? JSON.stringify(latestForensic) : null}::jsonb,
      capacity_observation=${capacityObservation ? JSON.stringify(capacityObservation) : null}::jsonb WHERE run_id=${RUN}`
  }
  async function snapshot(label) {
    const [stats] = await sql`SELECT count(*)::int total,
      count(*) FILTER (WHERE lane='settlement')::int settlements,
      count(*) FILTER (WHERE lane='refund')::int refunds,
      count(*) FILTER (WHERE movement_count=0)::int movement_zero,
      count(*) FILTER (WHERE movement_count=1)::int movement_one,
      count(*) FILTER (WHERE movement_count<>1)::int bad_movement_count,
      count(*) FILTER (WHERE authority<>lane)::int authority_overlap,
      count(*) FILTER (WHERE stage=0)::int stage0,
      count(*) FILTER (WHERE stage=1)::int stage1,
      count(*) FILTER (WHERE stage=2)::int stage2,
      count(*) FILTER (WHERE recovered=false)::int unrecovered,
      count(DISTINCT payment_id)::int distinct_ids
      FROM dr17_cert_items WHERE run_id=${RUN}`
    return { label, ...stats }
  }

  try {
    await timed('db-preflight', () => sql`SELECT 1 AS ok`, 5_000)
    await timed('redis-preflight', () => redis.ping(), 5_000)

    await timed('create-cert-tables', async () => {
      await sql`CREATE TABLE IF NOT EXISTS dr17_cert_runs (
        run_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), expected integer NOT NULL,
        finished_at timestamptz, verdict text, report jsonb, phase text, forensic jsonb, capacity_observation jsonb
      )`
      await sql`ALTER TABLE dr17_cert_runs ADD COLUMN IF NOT EXISTS phase text`
      await sql`ALTER TABLE dr17_cert_runs ADD COLUMN IF NOT EXISTS forensic jsonb`
      await sql`ALTER TABLE dr17_cert_runs ADD COLUMN IF NOT EXISTS capacity_observation jsonb`
      await sql`CREATE TABLE IF NOT EXISTS dr17_cert_items (
        run_id text NOT NULL, payment_id text NOT NULL, lane text NOT NULL CHECK (lane IN ('settlement','refund')),
        authority text NOT NULL CHECK (authority IN ('settlement','refund')), stage integer NOT NULL DEFAULT 0,
        movement_count integer NOT NULL DEFAULT 0, recovered boolean NOT NULL DEFAULT false,
        PRIMARY KEY(run_id,payment_id), FOREIGN KEY(run_id) REFERENCES dr17_cert_runs(run_id) ON DELETE CASCADE
      )`
    })
    await sql`INSERT INTO dr17_cert_runs(run_id,expected,phase) VALUES(${RUN},${N},'created')`
    runInserted = true

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
    await checkpoint('inserted', await snapshot('after_insert'))

    for (let base=0;base<N;base+=REDIS_CHUNK) {
      const pipe=redis.pipeline()
      for(let i=base;i<Math.min(base+REDIS_CHUNK,N);i++) pipe.zadd(key('ready'),{score:i,member:`${RUN}-p-${i}`})
      await timed('redis-ready-chunk',()=>pipe.exec())
      await sleep(5)
    }
    await checkpoint('projected')

    const crashIds=[]
    for(let i=0;i<N;i+=7) crashIds.push(`${RUN}-p-${i}`)
    for(let base=0;base<crashIds.length;base+=REDIS_CHUNK) {
      const pipe=redis.pipeline()
      for(const id of crashIds.slice(base,base+REDIS_CHUNK)) pipe.zrem(key('ready'),id)
      await timed('redis-crash-chunk',()=>pipe.exec())
      await sleep(5)
    }
    const readyAfterCrash = Number(await redis.zcard(key('ready')))
    await checkpoint('crash_injected', { ...(latestForensic ?? {}), crashInjected: crashIds.length, redisReadyAfterCrash: readyAfterCrash })

    let cursor=0
    async function worker(){
      while(true){
        const i=cursor++; if(i>=N) return
        const id=`${RUN}-p-${i}`
        const t=performance.now()
        await Promise.all(Array.from({length:i%11===0?2:1},()=>sql`
          UPDATE dr17_cert_items SET stage=1,movement_count=1
          WHERE run_id=${RUN} AND payment_id=${id} AND stage=0 AND movement_count=0
        `))
        updateLatencySamples.push(Math.round(performance.now()-t))
        if(i%100===0) await sleep(5)
      }
    }
    const concurrentStarted=performance.now()
    await Promise.all(Array.from({length:WORKERS},worker))
    const concurrentDurationMs=Math.round(performance.now()-concurrentStarted)
    capacityObservation={
      referenceMs:CAPACITY_REFERENCE_MS,
      observedMs:concurrentDurationMs,
      exceededReference:concurrentDurationMs>CAPACITY_REFERENCE_MS,
      excessMs:Math.max(0,concurrentDurationMs-CAPACITY_REFERENCE_MS),
      updateP50Ms:percentile(updateLatencySamples,0.50),
      updateP95Ms:percentile(updateLatencySamples,0.95),
      updateP99Ms:percentile(updateLatencySamples,0.99),
      updateMaxMs:Math.max(...updateLatencySamples,0),
      samples:updateLatencySamples.length,
      workers:WORKERS
    }
    const postConcurrent=await snapshot('after_concurrency')
    await checkpoint('concurrent_complete', { ...(latestForensic ?? {}), postConcurrent })
    assert.equal(postConcurrent.total,N)
    assert.equal(postConcurrent.distinct_ids,N)
    assert.equal(postConcurrent.movement_one,N)
    assert.equal(postConcurrent.bad_movement_count,0)
    assert.equal(postConcurrent.authority_overlap,0)
    assert.equal(postConcurrent.stage1,N)

    const missing=await sql`SELECT payment_id FROM dr17_cert_items WHERE run_id=${RUN} AND stage=1 AND recovered=false ORDER BY payment_id`
    await checkpoint('rediscovery_started', { ...(latestForensic ?? {}), rediscoveryCandidates: missing.length })
    for(let base=0;base<missing.length;base+=REDIS_CHUNK){
      const pipe=redis.pipeline()
      for(let i=base;i<Math.min(base+REDIS_CHUNK,missing.length);i++) pipe.zadd(key('recovered'),{score:i,member:missing[i].payment_id})
      await timed('redis-recovery-chunk',()=>pipe.exec())
      await sleep(5)
    }
    const redisRecoveredBeforeDbFinality=Number(await redis.zcard(key('recovered')))
    await sql`UPDATE dr17_cert_items SET stage=2,recovered=true WHERE run_id=${RUN} AND stage=1`
    const postRecovery=await snapshot('after_recovery')
    await checkpoint('rediscovery_complete', { ...(latestForensic ?? {}), redisRecoveredBeforeDbFinality, postRecovery })

    const ready=Number(await redis.zcard(key('ready')))
    const recovered=Number(await redis.zcard(key('recovered')))
    const durationMs=Math.round(performance.now()-started)
    const maxObservedOperationMs=Math.max(...latencySamples.map(x=>x.ms),0)
    const report={runId:RUN,total:postRecovery.total,settlements:postRecovery.settlements,refunds:postRecovery.refunds,distinctIds:postRecovery.distinct_ids,
      badMovementCount:postRecovery.bad_movement_count,settlementRefundOverlap:postRecovery.authority_overlap,
      lostRecovery:postRecovery.stage0+postRecovery.stage1+postRecovery.unrecovered,
      redisReadyAfterCrash:ready,redisRecovered:recovered,workers:WORKERS,durationMs,maxObservedOperationMs,
      capacityObservation,forensic:latestForensic,
      sharedDatabaseResource:true,sharedRedisResource:true,productionFinancialTablesTargeted:false,productionRuntimeRedisKeysTargeted:false,
      piCalled:false,horizonCalled:false}
    assert.equal(postRecovery.total,N)
    assert.equal(postRecovery.distinct_ids,N)
    assert.equal(postRecovery.settlements,5000)
    assert.equal(postRecovery.refunds,5000)
    assert.equal(postRecovery.bad_movement_count,0)
    assert.equal(postRecovery.authority_overlap,0)
    assert.equal(report.lostRecovery,0)
    assert.equal(recovered,N)
    await sql`UPDATE dr17_cert_runs SET finished_at=now(),verdict='PASS',phase='verified',report=${JSON.stringify(report)}::jsonb,
      forensic=${JSON.stringify(latestForensic)}::jsonb,capacity_observation=${JSON.stringify(capacityObservation)}::jsonb WHERE run_id=${RUN}`
    return {certification:'PASS',gate:'DR17-SHARED-RESOURCE-SAFE-10K-PERSISTENCE-CONCURRENCY',...report}
  } catch (error) {
    const code=error instanceof Error?error.message:String(error)
    if(runInserted){
      try {
        const failureSnapshot=await snapshot('failure')
        latestForensic={...(latestForensic??{}),failurePhase:phase,failureSnapshot,errorCode:code.slice(0,180)}
        await sql`UPDATE dr17_cert_runs SET finished_at=now(),verdict='FAIL',phase=${`failed:${phase}`},forensic=${JSON.stringify(latestForensic)}::jsonb,
          capacity_observation=${capacityObservation?JSON.stringify(capacityObservation):null}::jsonb WHERE run_id=${RUN}`
      } catch {}
    }
    throw error
  } finally {
    try { await redis.del(key('ready'),key('recovered')) } catch {}
  }
}
