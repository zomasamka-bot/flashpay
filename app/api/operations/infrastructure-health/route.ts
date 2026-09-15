import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"
import { isRedisConfigured, redis } from "@/lib/redis"
import { serverConfig } from "@/lib/server-config"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const RECOVERY_WAKE_KEY = "flashpay:operations:recovery-last-wake:v1"
const RECOVERY_FRESH_MS = 30 * 60_000
const CHECK_TIMEOUT_MS = 5_000
type CheckStatus = "pass" | "warn" | "fail" | "unknown"
type HealthCheck = { status: CheckStatus; detail: string; latencyMs?: number; observedAt?: string; ageMs?: number }
async function timed(check: () => Promise<boolean>): Promise<{ ok: boolean; latencyMs: number }> { const started=Date.now(); try{return{ok:await check(),latencyMs:Date.now()-started}}catch{return{ok:false,latencyMs:Date.now()-started}} }
async function fetchOk(url:string,init?:RequestInit):Promise<boolean>{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),CHECK_TIMEOUT_MS);try{const response=await fetch(url,{...init,signal:controller.signal,cache:"no-store"});return response.ok}finally{clearTimeout(timeout)}}
export async function GET(request: NextRequest) {
  const auth=await verifyOwnerAuthorizationHeader(request.headers.get("authorization")); if(!auth.ok)return NextResponse.json({error:"Unauthorized"},{status:auth.status})
  const asOf=new Date().toISOString(); const checks:Record<string,HealthCheck>={}
  const postgres=await timed(async()=>{if(!serverConfig.isPostgresConfigured)return false;const rows=await query("SELECT 1 AS ok");return Array.isArray(rows)&&rows.length===1&&Number((rows[0] as Record<string,unknown>)?.ok)===1})
  checks.postgres={status:postgres.ok?"pass":"fail",detail:postgres.ok?"PostgreSQL read succeeded":"PostgreSQL read unavailable",latencyMs:postgres.latencyMs}
  const redisRead=await timed(async()=>isRedisConfigured&&(await redis.ping())==="PONG")
  checks.redis={status:redisRead.ok?"pass":"fail",detail:redisRead.ok?"Redis responded to PING":"Redis unavailable",latencyMs:redisRead.latencyMs}
  const piApi=await timed(async()=>serverConfig.isPiApiKeyConfigured&&fetchOk("https://api.minepi.com/v2/payments/incomplete_server_payments",{headers:{Authorization:`Key ${serverConfig.piApiKey}`,Accept:"application/json"}}))
  checks.piApi={status:piApi.ok?"pass":"fail",detail:piApi.ok?"Pi Server API reachable":"Pi Server API unavailable",latencyMs:piApi.latencyMs}
  const horizon=await timed(()=>fetchOk("https://api.testnet.minepi.com/",{headers:{Accept:"application/json"}}))
  checks.horizon={status:horizon.ok?"pass":"fail",detail:horizon.ok?"Pi Testnet Horizon reachable":"Pi Testnet Horizon unavailable",latencyMs:horizon.latencyMs}
  if(!isRedisConfigured){checks.recoveryWake={status:"unknown",detail:"Recovery wake freshness unavailable because Redis is unavailable"}}else{try{const raw=await redis.get<unknown>(RECOVERY_WAKE_KEY);const observedAt=typeof raw==="string"?raw:undefined;const observedMs=observedAt?Date.parse(observedAt):NaN;if(!Number.isFinite(observedMs)||observedMs>Date.now()){checks.recoveryWake={status:"unknown",detail:"No valid trusted recovery wake timestamp has been observed yet"}}else{const ageMs=Date.now()-observedMs;checks.recoveryWake={status:ageMs<=RECOVERY_FRESH_MS?"pass":"warn",detail:ageMs<=RECOVERY_FRESH_MS?"Trusted recovery wake is fresh":"Trusted recovery wake is stale",observedAt,ageMs}}}catch{checks.recoveryWake={status:"unknown",detail:"Recovery wake freshness read failed"}}}
  const canonicalStorageHealthy=checks.postgres.status==="pass"&&checks.redis.status==="pass";checks.canonicalStorage={status:canonicalStorageHealthy?"pass":"fail",detail:canonicalStorageHealthy?"Canonical PostgreSQL + Redis storage dependencies are readable":"One or more canonical storage dependencies are unavailable"}
  const statuses=Object.values(checks).map(c=>c.status);const overall:CheckStatus=statuses.includes("fail")?"fail":statuses.includes("unknown")||statuses.includes("warn")?"warn":"pass"
  return NextResponse.json({overall,asOf,checks},{headers:{"Cache-Control":"no-store"}})
}
