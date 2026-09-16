import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"
import { isRedisConfigured, redis } from "@/lib/redis"
import { readSystemState } from "@/lib/system-control"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ACTIVE_KEY = "flashpay:recovery:active-payments:v1"
const READY_KEY = "flashpay:settlement:ready:v1"
const RECOVERY_WAKE_KEY = "flashpay:operations:recovery-last-wake:v1"
const WAKE_FRESH_MS = 30 * 60_000

type Overall = "healthy" | "degraded" | "maintenance" | "unknown"
function nonNegative(value: unknown): number | null { const n=Number(value); return Number.isSafeInteger(n)&&n>=0?n:null }

export async function GET(request: NextRequest) {
  const auth=await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if(!auth.ok) return NextResponse.json({error:"Unauthorized"},{status:auth.status})
  const asOf=new Date().toISOString()
  const control=await readSystemState()
  let financial: { settlementOpen:number; settlementFailed:number; refundPending:number; manualReview:number; oldestOpenAt:string|null } | null=null
  try {
    const rows=await query(`SELECT COUNT(*) FILTER (WHERE settlement_status IN ('pending','paid_to_app','settlement_pending')) AS settlement_open, COUNT(*) FILTER (WHERE settlement_status='settlement_failed') AS settlement_failed, MIN(created_at) FILTER (WHERE settlement_status IN ('pending','paid_to_app','settlement_pending','settlement_failed')) AS oldest_open_at FROM receipts`)
    const refunds=await query(`SELECT COUNT(*) FILTER (WHERE status='pending') AS refund_pending, COUNT(*) FILTER (WHERE status='manual_review_required') AS manual_review FROM refund_checkpoints`)
    const r=Array.isArray(rows)&&rows.length===1&&rows[0]&&typeof rows[0]==="object"?rows[0] as Record<string,unknown>:null
    const f=Array.isArray(refunds)&&refunds.length===1&&refunds[0]&&typeof refunds[0]==="object"?refunds[0] as Record<string,unknown>:null
    if(r&&f){const a=[nonNegative(r.settlement_open),nonNegative(r.settlement_failed),nonNegative(f.refund_pending),nonNegative(f.manual_review)];if(a.every(v=>v!==null)) financial={settlementOpen:a[0]!,settlementFailed:a[1]!,refundPending:a[2]!,manualReview:a[3]!,oldestOpenAt:r.oldest_open_at?String(r.oldest_open_at):null}}
  } catch {}
  let recovery: { active:number; ready:number; lastWakeAt:string|null; lastWakeAgeMs:number|null; wakeFresh:boolean|null } | null=null
  if(isRedisConfigured){try{const [active,ready,wake]=await Promise.all([redis.scard(ACTIVE_KEY),redis.zcard(READY_KEY),redis.get<unknown>(RECOVERY_WAKE_KEY)]);const a=nonNegative(active),r=nonNegative(ready);if(a!==null&&r!==null){const lastWakeAt=typeof wake==="string"?wake:null;const ms=lastWakeAt?Date.parse(lastWakeAt):NaN;const age=Number.isFinite(ms)&&ms<=Date.now()?Date.now()-ms:null;recovery={active:a,ready:r,lastWakeAt,lastWakeAgeMs:age,wakeFresh:age===null?null:age<=WAKE_FRESH_MS}}}catch{}}
  let overall: Overall="unknown", reason="One or more authoritative operational reads are unavailable"
  if(control.ok&&control.state.killSwitchEnabled){overall="maintenance";reason="Kill switch is enabled"}
  else if(control.ok&&financial&&recovery){const degraded=financial.settlementFailed>0||financial.refundPending>0||financial.manualReview>0||recovery.wakeFresh!==true;overall=degraded?"degraded":"healthy";reason=degraded?"Operational attention is required":"Authoritative operational signals are within normal bounds"}
  return NextResponse.json({overall,reason,asOf,control:control.ok?{available:true,killSwitchEnabled:control.state.killSwitchEnabled,revision:control.state.revision,lastToggleTime:control.state.lastToggleTime,expiresAt:control.state.expiresAt}:{available:false,reason:control.reason},financial,recovery},{headers:{"Cache-Control":"no-store"}})
}
