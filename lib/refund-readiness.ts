import "server-only"

import { Keypair } from "@stellar/stellar-sdk"
import { getRefundSchemaDiagnostics, verifyRefundAccountingSchema, verifyRefundTables } from "@/lib/refund-checkpoint-store"
import { isRedisConfigured, redis } from "@/lib/redis"
import { serverConfig } from "@/lib/server-config"

export type RefundReadiness = {
  ready: boolean
  checks: {
    refund_internal_secret: boolean
    pi_api_key: boolean
    pi_private_seed: boolean
    database_url: boolean
    redis_configured: boolean
    redis_read: boolean
    refund_schema: boolean
    refund_checkpoints: boolean
    refund_audit_events: boolean
    refund_accounting_schema: boolean
    idx_refund_checkpoints_status_retry: boolean
    idx_refund_checkpoints_payment: boolean
    idx_refund_audit_payment_created: boolean
    idx_refund_audit_refund_created: boolean
    pi_server_api_read: boolean
    testnet_horizon_read: boolean
  }
}

const HORIZON_TESTNET = "https://api.testnet.minepi.com"

async function checkPiServerApi(): Promise<boolean> {
  if (!serverConfig.piApiKey) return false
  try {
    const response = await fetch("https://api.minepi.com/v2/payments/incomplete_server_payments", {
      method: "GET",
      headers: { Authorization: `Key ${serverConfig.piApiKey}`, Accept: "application/json" },
      cache: "no-store",
    })
    return response.ok
  } catch {
    return false
  }
}

async function checkHorizon(seed: string | undefined): Promise<boolean> {
  if (!seed) return false
  try {
    const keypair = Keypair.fromSecret(seed)
    const response = await fetch(`${HORIZON_TESTNET}/accounts/${encodeURIComponent(keypair.publicKey())}`, {
      method: "GET", headers: { Accept: "application/json" }, cache: "no-store",
    })
    return response.ok
  } catch {
    return false
  }
}

export async function getRefundReadiness(): Promise<RefundReadiness> {
  const checks = {
    refund_internal_secret: Boolean(serverConfig.refundInternalSecret),
    pi_api_key: Boolean(serverConfig.piApiKey),
    pi_private_seed: false,
    database_url: Boolean(serverConfig.databaseUrl),
    redis_configured: isRedisConfigured,
    redis_read: false,
    refund_schema: false,
    refund_checkpoints: false,
    refund_audit_events: false,
    refund_accounting_schema: false,
    idx_refund_checkpoints_status_retry: false,
    idx_refund_checkpoints_payment: false,
    idx_refund_audit_payment_created: false,
    idx_refund_audit_refund_created: false,
    pi_server_api_read: false,
    testnet_horizon_read: false,
  }

  const seed = process.env.PI_PRIVATE_SEED
  if (seed) {
    try { Keypair.fromSecret(seed); checks.pi_private_seed = true } catch { checks.pi_private_seed = false }
  }

  if (isRedisConfigured) {
    try { await redis.get("flashpay:refund:readiness:probe"); checks.redis_read = true } catch { checks.redis_read = false }
  }

  const schema = await getRefundSchemaDiagnostics()
  Object.assign(checks, schema)
  checks.refund_schema = Object.values(schema).every(Boolean) && await verifyRefundTables()
  checks.refund_accounting_schema = await verifyRefundAccountingSchema()
  checks.pi_server_api_read = await checkPiServerApi()
  checks.testnet_horizon_read = await checkHorizon(seed)

  return { ready: Object.values(checks).every(Boolean), checks }
}
