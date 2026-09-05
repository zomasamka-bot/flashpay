import "server-only"

import {
  clearAutomaticRefundDeferral,
  deferAutomaticRefund,
  getRefundCheckpointReadOnly,
  listAutomaticRefundCheckpoints,
  markAutomaticRefundManualReview,
  findRefundCheckpointByPaymentId,
} from "@/lib/refund-checkpoint-store"
import { createRefundIntentInternal } from "@/lib/refund-intent-service"
import { executeRefundNextStep } from "@/lib/refund-executor"
import { isRedisConfigured, redis } from "@/lib/redis"
import type { RefundCheckpoint } from "@/lib/types"

export type AutomaticRefundPassResult =
  | { state: "blocked" }
  | { state: "ok"; processed: number; results: Array<{ refundId: string; paymentId: string; action: "intent" | "execute"; outcome: "success" | "deferred" | "blocked"; reason?: string }> }

const SHORT_RETRY_REASONS = new Set([
  "unavailable",
  "lock_conflict",
  "attempt_conflict",
  "blockchain_claim_conflict",
  "submit_failed",
  "completion_unverified",
  "intent_409",
  "intent_503",
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

async function deferAfterFailure(checkpoint: RefundCheckpoint, reason: string, thrown: boolean): Promise<boolean> {
  const current = await getRefundCheckpointReadOnly(checkpoint.refundId)
  if (current.state !== "present") return false
  const delay = retryDelayMs(reason, thrown)
  const deferred = await deferAutomaticRefund(
    current.checkpoint.refundId,
    current.checkpoint.stage,
    current.checkpoint.status,
    thrown ? "automatic_refund_exception" : "automatic_refund_blocked",
    reason,
    new Date(Date.now() + delay).toISOString(),
  )
  return deferred !== null
}

export type AutomaticRefundIntentResult =
  | { outcome: "created" | "existing" | "blocked"; paymentId: string; refundId?: string; reason?: string }

export async function ensureAutomaticRefundIntent(paymentId: string): Promise<AutomaticRefundIntentResult> {
  if (typeof paymentId !== "string" || paymentId.trim().length === 0) return { outcome: "blocked", paymentId, reason: "invalid_payment_id" }
  const first = await findRefundCheckpointByPaymentId(paymentId)
  if (first.state === "uncertain") return { outcome: "blocked", paymentId, reason: "checkpoint_uncertain" }
  if (first.state === "present") {
    if (first.checkpoint.status === "manual_review_required") {
      const manualReview = await markAutomaticRefundManualReview(first.checkpoint.refundId, first.checkpoint.stage)
      if (
        manualReview &&
        manualReview.refundId === first.checkpoint.refundId &&
        manualReview.paymentId === first.checkpoint.paymentId &&
        manualReview.stage === first.checkpoint.stage &&
        manualReview.status === "manual_review_required" &&
        manualReview.lastErrorCode === "refund_cancelled" &&
        manualReview.lastErrorMessage === "refund_cancelled" &&
        manualReview.nextRetryAt === undefined &&
        isRedisConfigured
      ) {
        try {
          await redis.srem("flashpay:recovery:active-payments:v1", first.checkpoint.paymentId)
        } catch (error) {
          console.warn("[refund/orchestrator] Active recovery index cleanup failed", error)
        }
      }
    }
    return { outcome: "existing", paymentId, refundId: first.checkpoint.refundId }
  }
  const key = `auto-refund:${paymentId}`
  const intent = await createRefundIntentInternal(paymentId, key)
  const second = await findRefundCheckpointByPaymentId(paymentId)
  if (second.state === "uncertain") return { outcome: "blocked", paymentId, reason: "intent_persistence_uncertain" }
  if (second.state === "present") {
    if ((intent.status === 200 || intent.status === 201) && second.checkpoint.idempotencyKey !== key) return { outcome: "blocked", paymentId, reason: "intent_identity_conflict" }
    return { outcome: intent.status === 201 ? "created" : "existing", paymentId, refundId: second.checkpoint.refundId }
  }
  if (intent.status === 200 || intent.status === 201) return { outcome: "blocked", paymentId, reason: "intent_persistence_uncertain" }
  return { outcome: "blocked", paymentId, reason: `intent_${intent.status}` }
}

export async function runAutomaticRefundPass(limit: number): Promise<AutomaticRefundPassResult> {
  if (!Number.isInteger(limit) || limit <= 0) return { state: "blocked" }
  const queued = await listAutomaticRefundCheckpoints(Math.min(limit, 20))
  if (queued.state !== "ok") return { state: "blocked" }

  let processed = 0
  const results: Array<{ refundId: string; paymentId: string; action: "intent" | "execute"; outcome: "success" | "deferred" | "blocked"; reason?: string }> = []
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

    const action = checkpoint.stage === "eligibility_verified" && checkpoint.status === "pending" ? "intent" : "execute"
    if (successful) {
      await clearAutomaticRefundDeferral(checkpoint.refundId)
      results.push({ refundId: checkpoint.refundId, paymentId: checkpoint.paymentId, action, outcome: "success" })
    } else {
      if (!thrown && reason === "refund_cancelled") {
        const manualReview = await markAutomaticRefundManualReview(checkpoint.refundId, checkpoint.stage)
        if (manualReview?.status === "manual_review_required") {
          results.push({ refundId: checkpoint.refundId, paymentId: checkpoint.paymentId, action, outcome: "blocked", reason })
          processed += 1
          continue
        }
      }
      const deferred = await deferAfterFailure(checkpoint, reason, thrown)
      results.push({ refundId: checkpoint.refundId, paymentId: checkpoint.paymentId, action, outcome: deferred ? "deferred" : "blocked", reason })
    }
    processed += 1
  }
  if (processed !== results.length) return { state: "blocked" }
  return { state: "ok", processed, results }
}
