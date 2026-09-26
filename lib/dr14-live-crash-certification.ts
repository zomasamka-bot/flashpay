import 'server-only'
import { query } from '@/lib/db'

export type Dr14Lane = 'settlement' | 'refund'
export type Dr14Boundary =
  | 'settlement_after_stage1_durable'
  | 'settlement_after_prepared_durable'
  | 'settlement_after_horizon_submit_before_checkpoint'
  | 'settlement_after_horizon_durable'
  | 'settlement_after_pi_durable'
  | 'settlement_after_db_durable'
  | 'refund_after_pi_create_before_id_checkpoint'
  | 'refund_after_prepared_before_submit'
  | 'refund_after_horizon_submit_before_tx_checkpoint'
  | 'refund_after_payment_checkpoint'
  | 'refund_after_accounting'
  | 'refund_after_audit'
  | 'refund_after_completion_before_projection'

const SETTLEMENT = new Set<Dr14Boundary>(['settlement_after_stage1_durable','settlement_after_prepared_durable','settlement_after_horizon_submit_before_checkpoint','settlement_after_horizon_durable','settlement_after_pi_durable','settlement_after_db_durable'])
const REFUND = new Set<Dr14Boundary>(['refund_after_pi_create_before_id_checkpoint','refund_after_prepared_before_submit','refund_after_horizon_submit_before_tx_checkpoint','refund_after_payment_checkpoint','refund_after_accounting','refund_after_audit','refund_after_completion_before_projection'])
export function dr14BoundaryLane(boundary: Dr14Boundary): Dr14Lane { return SETTLEMENT.has(boundary) ? 'settlement' : 'refund' }
export function isDr14Boundary(value: unknown): value is Dr14Boundary { return typeof value === 'string' && (SETTLEMENT.has(value as Dr14Boundary) || REFUND.has(value as Dr14Boundary)) }
function isRow(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

async function ensureTable(): Promise<boolean> {
  const r = await query(`CREATE TABLE IF NOT EXISTS certification_fault_arms (
    payment_id TEXT PRIMARY KEY,
    lane TEXT NOT NULL CHECK (lane IN ('settlement','refund')),
    boundary TEXT NOT NULL,
    armed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    consumed_at TIMESTAMP,
    CHECK (expires_at > armed_at)
  )`)
  return r !== null
}

export async function armDr14Crash(paymentId: string, boundary: Dr14Boundary): Promise<'ARMED'|'CONFLICT'|'INDETERMINATE'> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId) || !isDr14Boundary(boundary)) return 'CONFLICT'
  if (!await ensureTable()) return 'INDETERMINATE'
  const lane=dr14BoundaryLane(boundary)
  const identity=await query(`SELECT payment_id,stage FROM settlement_checkpoints WHERE payment_id=$1 LIMIT 2`,[paymentId])
  if (!Array.isArray(identity) || identity.length !== 1 || !isRow(identity[0]) || identity[0].payment_id !== paymentId) return 'CONFLICT'
  const opposite=await query(`SELECT refund_id,status FROM refund_checkpoints WHERE payment_id=$1 AND status<>'manual_review_required' LIMIT 2`,[paymentId])
  if (!Array.isArray(opposite)) return 'INDETERMINATE'
  if (lane==='settlement' && opposite.length!==0) return 'CONFLICT'
  const r=await query(`INSERT INTO certification_fault_arms(payment_id,lane,boundary,expires_at)
    VALUES($1,$2,$3,NOW()+INTERVAL '30 minutes')
    ON CONFLICT(payment_id) DO UPDATE SET lane=EXCLUDED.lane,boundary=EXCLUDED.boundary,armed_at=NOW(),expires_at=NOW()+INTERVAL '30 minutes',consumed_at=NULL
    WHERE certification_fault_arms.consumed_at IS NOT NULL OR certification_fault_arms.expires_at<=NOW()
    RETURNING payment_id`,[paymentId,lane,boundary])
  return Array.isArray(r)&&r.length===1?'ARMED':r===null?'INDETERMINATE':'CONFLICT'
}

export async function consumeDr14Crash(paymentId: string, boundary: Dr14Boundary): Promise<boolean> {
  if (process.env.VERCEL_ENV !== 'production' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId) || !isDr14Boundary(boundary)) return false
  const r=await query(`UPDATE certification_fault_arms SET consumed_at=NOW()
    WHERE payment_id=$1 AND lane=$2 AND boundary=$3 AND consumed_at IS NULL AND expires_at>NOW()
    RETURNING payment_id`,[paymentId,dr14BoundaryLane(boundary),boundary])
  if (!Array.isArray(r) || r.length!==1) return false
  console.warn('[DR14 LIVE CRASH INJECTION]',{paymentId,boundary,oneShotConsumed:true,financialAuthorityChanged:false})
  return true
}

export async function readDr14Crash(paymentId:string){
  if (!await ensureTable()) return null
  const r=await query(`SELECT payment_id,lane,boundary,armed_at,expires_at,consumed_at FROM certification_fault_arms WHERE payment_id=$1 LIMIT 2`,[paymentId])
  return Array.isArray(r)&&r.length===1?r[0]:null
}
