import { type NextRequest, NextResponse } from 'next/server'
import { redis, isRedisConfigured } from '@/lib/redis'
import { createRefundCheckpoint, claimRefundIdempotency, getRefundCheckpointByIdempotency, appendRefundAuditEvent, verifyRefundTables, releaseRefundIdempotency, acquirePaymentOperationLock, releasePaymentOperationLock, transitionRefundCheckpoint } from '@/lib/refund-checkpoint-store'
import type { Payment, RefundCheckpoint, RefundAuditEvent } from '@/lib/types'
import { isRefundEligible as checkEligibility } from '@/lib/types'
import { randomUUID } from 'node:crypto'
import { serverConfig } from '@/lib/server-config'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const INTERNAL_SECRET = serverConfig.refundInternalSecret

function hasInternalAuthorization(request: NextRequest): boolean {
  if (!INTERNAL_SECRET) return false
  const supplied = request.headers.get('x-refund-internal-secret')
  return supplied === INTERNAL_SECRET
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

/**
 * Phase 3: Refund intent creation handler.
 * POST /api/refunds/intent
 *
 * This endpoint creates a durable refund intent—verifies payer eligibility,
 * creates the checkpoint, records audit events, and returns the refund ID.
 * No wallet submission occurs yet.
 *
 * Request body:
 * {
 *   paymentId: string,
 *   idempotencyKey: string,
 *   payerUid?: string (will be verified from payment record)
 * }
 *
 * Safety guarantees:
 * - Only one refund per payment (unique constraint).
 * - One idempotency claim per idempotency key (Redis lock).
 * - Payment must be in settlement_failed + refund_pending state.
 * - Payer UID must be verified on source payment.
 * - No payment or settlement state is modified.
 */
export async function POST(request: NextRequest) {
  try {
    if (!hasInternalAuthorization(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
    }
    if (!isRedisConfigured) {
      return NextResponse.json({ error: 'Refund store unavailable' }, { status: 503, headers: corsHeaders })
    }
    const tablesReady = await verifyRefundTables()
    if (!tablesReady) {
      return NextResponse.json({ error: 'Refund tables unavailable' }, { status: 503, headers: corsHeaders })
    }
    const body = await request.json()
    const { paymentId, idempotencyKey } = body

    console.log('[refunds/intent] Request received:', { paymentId, idempotencyKey })

    // 1. Validate required fields
    if (!paymentId || typeof paymentId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid paymentId' },
        { status: 400, headers: corsHeaders }
      )
    }

    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid idempotencyKey' },
        { status: 400, headers: corsHeaders }
      )
    }

    // Redis is the canonical payment source in this application.
    const stored = await redis.get(`payment:${paymentId}`)
    if (!stored) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404, headers: corsHeaders })
    }
    const paymentRecord: any = typeof stored === 'string' ? JSON.parse(stored) : stored

    // Normalize snake_case to camelCase for type checking
    const payment: Payment = {
      id: paymentRecord.id,
      merchantId: paymentRecord.merchant_id || paymentRecord.merchantId,
      merchantUid: paymentRecord.merchant_uid || paymentRecord.merchantUid,
      merchantAddress: paymentRecord.merchant_address || paymentRecord.merchantAddress,
      accessToken: paymentRecord.access_token || paymentRecord.accessToken,
      amount: Number(paymentRecord.amount),
      customerAmount: paymentRecord.customerAmount !== undefined && paymentRecord.customerAmount !== null
        ? Number(paymentRecord.customerAmount)
        : paymentRecord.customer_amount !== undefined && paymentRecord.customer_amount !== null
          ? Number(paymentRecord.customer_amount)
          : undefined,
      note: paymentRecord.note,
      status: paymentRecord.status,
      settlementFailureState: paymentRecord.settlement_failure_state || paymentRecord.settlementFailureState,
      payerUid: paymentRecord.payerUid,
      payerUidSource: paymentRecord.payerUidSource,
      payerUidCapturedAt: paymentRecord.payerUidCapturedAt,
      payerRefundEligible: paymentRecord.payerRefundEligible === true,
      a2uPaymentId: paymentRecord.a2uPaymentId,
      a2uTxid: paymentRecord.a2uTxid,
      horizonSuccessFlag: paymentRecord.horizonSuccessFlag === true,
      refundStatus: paymentRecord.refund_status || paymentRecord.refundStatus,
      refundPaymentId: paymentRecord.refund_payment_id || paymentRecord.refundPaymentId,
      refundTxid: paymentRecord.refund_txid || paymentRecord.refundTxid,
      createdAt: paymentRecord.created_at || paymentRecord.createdAt,
    }

    if (payment.id !== paymentId || !payment.id) {
      return NextResponse.json({ error: 'Payment ID mismatch' }, { status: 422, headers: corsHeaders })
    }
    if (payment.refundPaymentId || payment.refundTxid) {
      return NextResponse.json({ error: 'Refund transfer evidence already exists' }, { status: 422, headers: corsHeaders })
    }

    const canonicalAmount = paymentRecord.customerAmount
    const legacyAmount = paymentRecord.customer_amount
    if (canonicalAmount !== undefined && canonicalAmount !== null && legacyAmount !== undefined && legacyAmount !== null &&
      (!Number.isFinite(Number(canonicalAmount)) || !Number.isFinite(Number(legacyAmount)) || Number(canonicalAmount) !== Number(legacyAmount))) {
      return NextResponse.json({ error: 'Conflicting customerAmount values' }, { status: 422, headers: corsHeaders })
    }

    console.log('[refunds/intent] Payment loaded:', {
      id: payment.id,
      status: payment.status,
      settlementFailureState: payment.settlementFailureState,
      payerRefundEligible: payment.payerRefundEligible,
      refundStatus: payment.refundStatus,
    })

    if (typeof payment.customerAmount !== 'number' || !Number.isFinite(payment.customerAmount) || payment.customerAmount <= 0) {
      return NextResponse.json({ error: 'Verified customerAmount is required' }, { status: 422, headers: corsHeaders })
    }

    // 4. Verify eligibility using the pure guard function
    if (!checkEligibility(payment)) {
      console.warn('[refunds/intent] Payment ineligible for refund:', {
        status: payment.status,
        settlementFailureState: payment.settlementFailureState,
        payerRefundEligible: payment.payerRefundEligible,
        payerUid: !!payment.payerUid,
        refundStatus: payment.refundStatus,
      })

      return NextResponse.json(
        { error: 'Payment is not eligible for refund' },
        { status: 422, headers: corsHeaders }
      )
    }

    // Resume an existing durable intent before creating anything new. This
    // prevents partial checkpoint/audit failures from burning a retry key.
    const existing = await getRefundCheckpointByIdempotency(idempotencyKey)
    if (existing) {
      if (existing.paymentId !== payment.id || existing.payerUid !== payment.payerUid || existing.amount !== payment.customerAmount) {
        return NextResponse.json({ error: 'Idempotency key is bound to different refund inputs' }, { status: 409, headers: corsHeaders })
      }
      if (existing.stage === 'eligibility_verified') {
        const transitioned = await transitionRefundCheckpoint(existing.refundId, 'eligibility_verified', 'intent_created', 'pending')
        if (!transitioned) return NextResponse.json({ error: 'Refund intent transition conflict' }, { status: 409, headers: corsHeaders })
        const requested = await appendRefundAuditEvent({
          eventId: randomUUID(), refundId: existing.refundId, paymentId: existing.paymentId,
          eventType: 'refund_requested', actorType: 'system', idempotencyKey,
          createdAt: new Date().toISOString(), details: { resumed: true },
        })
        if (!requested) return NextResponse.json({ error: 'Refund request audit unavailable', refundId: existing.refundId }, { status: 503, headers: corsHeaders })
        return NextResponse.json({ success: true, refund: transitioned }, { status: 200, headers: corsHeaders })
      }
      return NextResponse.json({ success: true, refund: existing }, { status: 200, headers: corsHeaders })
    }

    // 5. Claim idempotency only after eligibility is verified, then create the
    // durable checkpoint. The database unique constraints remain authoritative.
    const refundId = randomUUID()
    const paymentLockAcquired = await acquirePaymentOperationLock(payment.id, refundId)
    if (!paymentLockAcquired) {
      return NextResponse.json({ error: 'Payment is already being processed' }, { status: 409, headers: corsHeaders })
    }
    const idempotencyClaimed = await claimRefundIdempotency(idempotencyKey, refundId)
    if (!idempotencyClaimed) {
      await releasePaymentOperationLock(payment.id, refundId)
      return NextResponse.json(
        { error: 'Idempotency key already in use' },
        { status: 409, headers: corsHeaders }
      )
    }
    const now = new Date().toISOString()

    const checkpoint: RefundCheckpoint = {
      refundId,
      paymentId: payment.id,
      idempotencyKey,
      status: 'pending',
      stage: 'eligibility_verified',
      payerUid: payment.payerUid!,
      payerUidVerifiedAt: payment.payerUidCapturedAt || now,
      amount: payment.customerAmount,
      currency: 'π',
      sourcePaymentStatus: payment.status,
      sourceSettlementState: payment.settlementFailureState!,
      createdAt: now,
      updatedAt: now,
      attemptCount: 0,
    }

    console.log('[refunds/intent] Creating checkpoint:', {
      refundId,
      paymentId,
      amount: checkpoint.amount,
      stage: checkpoint.stage,
    })

    const persistedCheckpoint = await createRefundCheckpoint(checkpoint)
    if (!persistedCheckpoint) {
      await releaseRefundIdempotency(idempotencyKey, refundId)
      await releasePaymentOperationLock(payment.id, refundId)
      console.error('[refunds/intent] Failed to create checkpoint; idempotency claim released for safe retry')
      return NextResponse.json(
        { error: 'Refund intent creation failed - duplicate or database error' },
        { status: 409, headers: corsHeaders }
      )
    }

    // 6. Record the successful eligibility verification audit event
    const auditEventId = randomUUID()
    const auditEvent: RefundAuditEvent = {
      eventId: auditEventId,
      refundId,
      paymentId: payment.id,
      eventType: 'eligibility_verified',
      actorType: 'system',
      idempotencyKey,
      createdAt: now,
      details: {
        refundAmount: checkpoint.amount,
        payerUid: checkpoint.payerUid.substring(0, 8),
        stage: checkpoint.stage,
      },
    }

    const auditRecorded = await appendRefundAuditEvent(auditEvent)
    if (!auditRecorded) {
      console.error('[refunds/intent] Audit durability failed; intent remains checkpointed')
      return NextResponse.json(
        { error: 'Refund intent checkpointed but audit recording failed', refundId },
        { status: 503, headers: corsHeaders }
      )
    }

    const transitioned = await transitionRefundCheckpoint(refundId, 'eligibility_verified', 'intent_created', 'pending')
    if (!transitioned) return NextResponse.json({ error: 'Refund intent transition conflict', refundId }, { status: 409, headers: corsHeaders })
    const requested = await appendRefundAuditEvent({
      eventId: randomUUID(), refundId, paymentId: payment.id, eventType: 'refund_requested',
      actorType: 'system', idempotencyKey, createdAt: now, details: { stage: 'intent_created' },
    })
    if (!requested) return NextResponse.json({ error: 'Refund request audit unavailable', refundId }, { status: 503, headers: corsHeaders })

    console.log('[refunds/intent] Refund intent created successfully:', refundId)

    return NextResponse.json(
      {
        success: true,
        refund: {
          id: refundId,
          paymentId: payment.id,
          status: persistedCheckpoint.status,
          stage: persistedCheckpoint.stage,
          amount: persistedCheckpoint.amount,
          currency: persistedCheckpoint.currency,
          createdAt: persistedCheckpoint.createdAt,
        },
      },
      { status: 201, headers: corsHeaders }
    )
  } catch (error) {
    console.error('[refunds/intent] Unhandled error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: corsHeaders }
    )
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200, headers: corsHeaders })
}
