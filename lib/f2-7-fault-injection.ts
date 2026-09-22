import "server-only"

import { redis, isRedisConfigured } from "./redis"
import { serverConfig } from "./server-config"

export const F27_CERT_MERCHANT_ID = "hazemaboria"
export const F27_CERT_MERCHANT_UID = "ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa"
export const F27_SETTLEMENT_AMOUNT = 0.16
export const F27_REFUND_AMOUNT = 0.1

export const F27_SETTLEMENT_POINTS = [
  "u2a_verified_before_pi_complete",
  "pi_complete_before_u2a_completed",
  "u2a_completed_before_redis_projection",
  "a2u_created_before_local_checkpoint",
  "a2u_checkpoint_before_prepared",
  "prepared_before_horizon_submit",
  "horizon_success_before_durable_checkpoint",
  "horizon_checkpoint_before_pi_complete",
  "pi_complete_before_durable_checkpoint",
  "durable_pi_before_db",
  "db_commit_before_durable_finality",
  "db_finality_before_redis_final",
] as const

export const F27_REFUND_POINTS = [
  "refund_intent_before_pi_create",
  "refund_pi_create_before_id_checkpoint",
  "refund_prepared_before_horizon_submit",
  "refund_horizon_success_before_tx_checkpoint",
  "refund_tx_checkpoint_before_pi_complete",
  "refund_pi_complete_before_payment_checkpoint",
  "refund_payment_checkpoint_before_accounting",
  "refund_accounting_before_audit",
  "refund_audit_before_completion",
  "refund_completion_before_redis_final",
] as const

export type F27SettlementFaultPoint = typeof F27_SETTLEMENT_POINTS[number]
export type F27RefundFaultPoint = typeof F27_REFUND_POINTS[number]
export type F27FaultPoint = F27SettlementFaultPoint | F27RefundFaultPoint
export type F27Lane = "settlement" | "refund"

type Input = {
  lane: F27Lane
  point: F27FaultPoint
  paymentId: string
  merchantId: string
  merchantUid: string
  amount: number
  details?: Record<string, string | number | boolean | null>
}

function exactTarget(input: Input): boolean {
  if (serverConfig.vercelEnv !== "production" || !isRedisConfigured) return false
  if (input.merchantId !== F27_CERT_MERCHANT_ID || input.merchantUid !== F27_CERT_MERCHANT_UID) return false
  if (!input.paymentId || input.paymentId !== input.paymentId.trim()) return false
  if (input.lane === "settlement") return input.amount === F27_SETTLEMENT_AMOUNT && (F27_SETTLEMENT_POINTS as readonly string[]).includes(input.point)
  return input.amount === F27_REFUND_AMOUNT && (F27_REFUND_POINTS as readonly string[]).includes(input.point)
}

/**
 * F2-7 controlled live fault injector.
 * It owns diagnostic Redis keys only. It never calls Pi/Horizon/PostgreSQL and
 * never writes a financial Payment projection. One exact payment owns each lane
 * for seven days, and each named crash boundary is injected exactly once.
 */
export async function maybeInjectF27Fault(input: Input): Promise<boolean> {
  if (!exactTarget(input)) return false
  const runVersion = input.lane === "refund" ? "v2" : "v1"
  const runKey = `flashpay:diagnostic:f2-7:${input.lane}:run:${runVersion}`
  let owner = await redis.get<string>(runKey).catch(() => null)
  if (owner === null) {
    const created = await redis.set(runKey, input.paymentId, { nx: true, ex: 7 * 24 * 60 * 60 }).catch(() => null)
    if (created !== "OK") owner = await redis.get<string>(runKey).catch(() => null)
    else owner = input.paymentId
  }
  if (owner !== input.paymentId) return false

  const pointKey = `flashpay:diagnostic:f2-7:${input.lane}:point:${runVersion}:${input.paymentId}:${input.point}`
  const claimed = await redis.set(pointKey, "1", { nx: true, ex: 7 * 24 * 60 * 60 }).catch(() => null)
  if (claimed !== "OK") return false
  console.log("[F2-7 FAULT INJECTION]", {
    lane: input.lane,
    point: input.point,
    paymentId: input.paymentId,
    amount: input.amount,
    financialMutation: false,
    injectorPiCall: false,
    injectorHorizonCall: false,
    injectorPostgresCall: false,
    ...(input.details ?? {}),
  })
  return true
}
