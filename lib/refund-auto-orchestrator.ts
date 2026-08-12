import "server-only"

import {
  clearAutomaticRefundDeferral,
  deferAutomaticRefund,
  getRefundCheckpointReadOnly,
  listAutomaticRefundCheckpoints,
} from "@/lib/refund-checkpoint-store"
import { createRefundIntentInternal } from "@/lib/refund-intent-service"
import { executeRefundNextStep } from "@/lib/refund-executor"
import type { RefundCheckpoint } from "@/lib/types"

export type AutomaticRefundPassResult =
  | { state: "blocked" }
  | { state: "ok"; processed: number }

const SHORT_RETRY_REASONS = new Set([
  "unavailable",
  "lock_conflict",
  "attempt_conflict",
  "blockchain_claim_conflict",
  "submit_failed",
  "completion_unverified",
])

function isIntentSuccess(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false
  const value = result as Record<string, unknown>
  return (value.status === 200 || value.status === 201) && Boolean(value.body)
}

function isExecutorSuccess(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false
  const value = result as Record<string, unknown>
  return value.outcome === "found" || value.outcome === "ready_for_submission"
}

function failureReason(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "uncertain"
  const reason = (result as Record<string, unknown>).reason
  return typeof reason === "string" ? reason : "uncertain"
}

function retryDelayMs(reason: string, thrown: boolean): number {
  if (thrown) return 60_000
  const normalized = reason.toLowerCase()
  if (normalized.includes("uncertain") || SHORT_RETRY_REASONS.has(normalized)) return 60_000
  return 15 * 60_000
}

async function deferAfterFailure(checkpoint: RefundCheckpoint, reason: string, thrown: boolean): Promise<void> {
  const current = await getRefundCheckpointReadOnly(checkpoint.refundId)
  if (current.state !== "present") return
  const delay = retryDelayMs(reason, thrown)
  await deferAutomaticRefund(
    current.checkpoint.refundId,
    current.checkpoint.stage,
    current.checkpoint.status,
    thrown ? "automatic_refund_exception" : "automatic_refund_blocked",
    reason,
    new Date(Date.now() + delay).toISOString(),
  )
}

export async function runAutomaticRefundPass(limit: number): Promise<AutomaticRefundPassResult> {
  if (!Number.isInteger(limit) || limit <= 0) return { state: "blocked" }
  const queued = await listAutomaticRefundCheckpoints(Math.min(limit, 20))
  if (queued.state !== "ok") return { state: "blocked" }

  let processed = 0
  for (const checkpoint of queued.checkpoints) {
    let successful = false
    let reason = "uncertain"
    let thrown = false
    try {
      if (checkpoint.stage === "eligibility_verified" && checkpoint.status === "pending") {
        const result = await createRefundIntentInternal(checkpoint.paymentId, checkpoint.idempotencyKey)
        successful = isIntentSuccess(result)
        if (!successful) reason = `intent_${String((result as Record<string, unknown>)?.status ?? "blocked")}`
      } else {
        const result = await executeRefundNextStep(checkpoint.refundId)
        successful = isExecutorSuccess(result)
        if (!successful) reason = failureReason(result)
      }
    } catch (error) {
      thrown = true
      reason = error instanceof Error && error.message ? error.message : "automatic refund exception"
    }

    if (successful) {
      await clearAutomaticRefundDeferral(checkpoint.refundId)
    } else {
      await deferAfterFailure(checkpoint, reason, thrown)
    }
    processed += 1
  }
  return { state: "ok", processed }
}
