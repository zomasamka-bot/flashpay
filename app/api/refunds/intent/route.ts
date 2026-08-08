'use server'

import { type NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { createRefundCheckpoint, claimRefundIdempotency, appendRefundAuditEvent } from '@/lib/refund-checkpoint-store'
import type { Payment, RefundCheckpoint, RefundAuditEvent } from '@/lib/types'
import { isRefundEligible as checkEligibility } from '@/lib/types'
import { randomUUID } from 'node:crypto'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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

    // 2. Fetch payment record from the authoritative database before claiming
    // idempotency. Invalid requests must not consume a retry key.
    // 3. Fetch payment record from database
    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { error: 'Database not configured' },
        { status: 500, headers: corsHeaders }
      )
    }

    let paymentRecord: any = null
    try {
      const result = await query('SELECT * FROM payments WHERE id = $1', [paymentId])
      if (!Array.isArray(result) || result.length === 0) {
        return NextResponse.json(
          { error: 'Payment not found' },
          { status: 404, headers: corsHeaders }
        )
      }
      paymentRecord = result[0]
    } catch (err) {
      console.error('[refunds/intent] Database query failed:', err)
      return NextResponse.json(
        { error: 'Failed to fetch payment' },
        { status: 500, headers: corsHeaders }
      )
    }

    // Normalize snake_case to camelCase for type checking
    const payment: Payment = {
      id: paymentRecord.id,
      merchantId: paymentRecord.merchant_id || paymentRecord.merchantId,
      merchantUid: paymentRecord.merchant_uid || paymentRecord.merchantUid,
      merchantAddress: paymentRecord.merchant_address || paymentRecord.merchantAddress,
      accessToken: paymentRecord.access_token || paymentRecord.accessToken,
      amount: Number(paymentRecord.amount),
      customerAmount: paymentRecord.customer_amount ? Number(paymentRecord.customer_amount) : undefined,
      note: paymentRecord.note,
      status: paymentRecord.status,
      settlementFailureState: paymentRecord.settlement_failure_state || paymentRecord.settlementFailureState,
      payerUid: paymentRecord.payer_uid || paymentRecord.payerUid,
      payerUidCapturedAt: paymentRecord.payer_uid_captured_at || paymentRecord.payerUidCapturedAt,
      payerRefundEligible: paymentRecord.payer_refund_eligible || paymentRecord.payerRefundEligible,
      refundStatus: paymentRecord.refund_status || paymentRecord.refundStatus,
      createdAt: paymentRecord.created_at || paymentRecord.createdAt,
    }

    console.log('[refunds/intent] Payment loaded:', {
      id: payment.id,
      status: payment.status,
      settlementFailureState: payment.settlementFailureState,
      payerRefundEligible: payment.payerRefundEligible,
      refundStatus: payment.refundStatus,
    })

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

    // 5. Claim idempotency only after eligibility is verified, then create the
    // durable checkpoint. The database unique constraints remain authoritative.
    const refundId = randomUUID()
    const idempotencyClaimed = await claimRefundIdempotency(idempotencyKey, refundId)
    if (!idempotencyClaimed) {
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
      amount: payment.customerAmount || payment.amount,
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
      console.error('[refunds/intent] Failed to create checkpoint (may be duplicate payment)')
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
