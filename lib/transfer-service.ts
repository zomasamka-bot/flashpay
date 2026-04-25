'use server'

import { config } from './config'
import { updateTransferStatus, getTransfer } from './db'
import {
  notifyTransferSuccess,
  notifyTransferFailed,
  notifyTransferRetry,
  notifyTransferPending,
} from './notification-service'

/**
 * Pi Network wallet-to-wallet transfer service
 * Handles fund transfers from app wallet to merchant wallet via A2U Payments
 * 
 * Important: Pi Network doesn't have a dedicated "wallet transfer" endpoint.
 * Instead, merchant payouts use A2U (App-To-User) Payments:
 *   POST /payments - Create A2U payment to merchant's uid
 *   POST /payments/{payment_id}/approve - Approve the payout
 *   POST /payments/{payment_id}/complete - Complete with txid
 * 
 * Testnet: https://api.minepi.com/v2
 */

const MAX_RETRY_ATTEMPTS = 5
const RETRY_DELAYS = [2000, 5000, 10000, 30000, 60000] // Exponential backoff in ms
const PI_API_BASE = 'https://api.minepi.com/v2'

/**
 * Execute a payout from app wallet to merchant wallet via A2U Payment
 */
export async function executeTransfer(
  transferId: string,
  merchantAddress: string,
  amount: number,
  memo: string = 'FlashPay payout'
): Promise<{
  success: boolean
  piTransferId?: string
  error?: string
}> {
  if (!config.isPiApiKeyConfigured) {
    console.error('[Transfer] PI_API_KEY not configured')
    return { success: false, error: 'Server not configured for transfers' }
  }

  if (!merchantAddress) {
    console.error('[Transfer] No merchant address (uid) provided')
    return { success: false, error: 'Merchant wallet address (uid) required' }
  }

  try {
    console.log('[Transfer] ========================================')
    console.log('[Transfer] TRANSFER EXECUTION STARTED')
    console.log('[Transfer]   transferId:', transferId)
    console.log('[Transfer]   merchantAddress (uid):', merchantAddress)
    console.log('[Transfer]   amount:', amount)
    console.log('[Transfer]   memo:', memo)
    console.log('[Transfer] ========================================')

    // Notify transfer initiated
    notifyTransferPending(amount, merchantAddress)

    // Step 1: Create A2U Payment for merchant
    console.log('[Transfer] STEP 1: Creating A2U payment...')
    const paymentPayload = {
      payment: {
        amount: amount,
        memo: memo,
        metadata: { transferId, type: 'merchant_payout' },
        uid: merchantAddress, // Pi's uid for the merchant
      },
    }

    console.log('[Transfer] Sending A2U Payment to:', `${PI_API_BASE}/payments`)
    console.log('[Transfer] Request Headers:', {
      Authorization: 'Key ' + config.piApiKey?.substring(0, 20) + '...',
      'Content-Type': 'application/json',
    })
    console.log('[Transfer] Request Body:', JSON.stringify(paymentPayload, null, 2))

    const createResponse = await fetch(`${PI_API_BASE}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${config.piApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(paymentPayload),
    })

    const createData = await createResponse.json().catch(() => ({}))

    console.log('[Transfer] ========== STEP 1 RESPONSE ==========')
    console.log('[Transfer] Status Code:', createResponse.status)
    console.log('[Transfer] Status OK:', createResponse.ok)
    console.log('[Transfer] Response Headers:', {
      contentType: createResponse.headers.get('content-type'),
      contentLength: createResponse.headers.get('content-length'),
    })
    console.log('[Transfer] Response Body:', JSON.stringify(createData, null, 2))
    console.log('[Transfer] ======================================')

    if (!createResponse.ok) {
      const errorMsg =
        createData.error?.message ||
        createData.message ||
        `Failed to create A2U payment: ${createResponse.status}`

      console.error('[Transfer] A2U Payment creation failed:', {
        status: createResponse.status,
        error: errorMsg,
        fullResponse: JSON.stringify(createData),
      })

      notifyTransferFailed(transferId, errorMsg, true)
      return { success: false, error: errorMsg }
    }

    const paymentId = createData.payment?.identifier
    if (!paymentId) {
      const errorMsg = 'No payment identifier in Pi API response'
      console.error('[Transfer]', errorMsg)
      notifyTransferFailed(transferId, errorMsg, true)
      return { success: false, error: errorMsg }
    }

    console.log('[Transfer] ✓ A2U Payment created:', paymentId)

    // Step 2: Approve the payment
    console.log('[Transfer] STEP 2: Approving A2U payment...')
    console.log('[Transfer] URL:', `${PI_API_BASE}/payments/${paymentId}/approve`)
    console.log('[Transfer] Request Body: {}')
    
    const approveResponse = await fetch(`${PI_API_BASE}/payments/${paymentId}/approve`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${config.piApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    const approveData = await approveResponse.json().catch(() => ({}))

    console.log('[Transfer] ========== STEP 2 RESPONSE ==========')
    console.log('[Transfer] Status Code:', approveResponse.status)
    console.log('[Transfer] Status OK:', approveResponse.ok)
    console.log('[Transfer] Response Body:', JSON.stringify(approveData, null, 2))
    console.log('[Transfer] ======================================')

    if (!approveResponse.ok) {
      const errorMsg =
        approveData.error?.message ||
        approveData.message ||
        `Failed to approve A2U payment: ${approveResponse.status}`

      console.error('[Transfer] A2U Payment approval failed:', {
        status: approveResponse.status,
        error: errorMsg,
        fullResponse: JSON.stringify(approveData),
      })

      notifyTransferFailed(transferId, errorMsg, true)
      return { success: false, error: errorMsg }
    }

    console.log('[Transfer] ✓ A2U Payment approved')

    // Step 3: Complete the payment with txid
    // On Testnet, the txid comes from the blockchain transaction
    // For now, we'll use the paymentId as a pseudo-txid
    const pseudoTxid = `${paymentId}-${Date.now()}`

    console.log('[Transfer] STEP 3: Completing A2U payment with txid...')
    console.log('[Transfer] URL:', `${PI_API_BASE}/payments/${paymentId}/complete`)
    console.log('[Transfer] Request Body:', JSON.stringify({ txid: pseudoTxid }, null, 2))
    
    const completeResponse = await fetch(`${PI_API_BASE}/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${config.piApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txid: pseudoTxid }),
    })

    const completeData = await completeResponse.json().catch(() => ({}))

    console.log('[Transfer] ========== STEP 3 RESPONSE ==========')
    console.log('[Transfer] Status Code:', completeResponse.status)
    console.log('[Transfer] Status OK:', completeResponse.ok)
    console.log('[Transfer] Response Headers:', {
      contentType: completeResponse.headers.get('content-type'),
      contentLength: completeResponse.headers.get('content-length'),
    })
    console.log('[Transfer] Response Body:', JSON.stringify(completeData, null, 2))
    console.log('[Transfer] ======================================')

    if (!completeResponse.ok) {
      const errorMsg =
        completeData.error?.message ||
        completeData.message ||
        `Failed to complete A2U payment: ${completeResponse.status}`

      console.error('[Transfer] A2U Payment completion failed:', {
        status: completeResponse.status,
        error: errorMsg,
        fullResponse: JSON.stringify(completeData),
      })

      notifyTransferFailed(transferId, errorMsg, true)
      return { success: false, error: errorMsg }
    }

    console.log('[Transfer] ========================================')
    console.log('[Transfer] ✓ TRANSFER SUCCESSFUL')
    console.log('[Transfer]   transferId:', transferId)
    console.log('[Transfer]   piPaymentId:', paymentId)
    console.log('[Transfer]   amount:', amount)
    console.log('[Transfer]   merchantAddress (uid):', merchantAddress)
    console.log('[Transfer] ========================================')

    // Update transfer status to completed
    await updateTransferStatus(transferId, 'completed', paymentId)

    // Notify success
    notifyTransferSuccess(transferId, amount, merchantAddress)

    return { success: true, piTransferId: paymentId }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    console.error('[Transfer] Transfer execution failed:', errorMsg)

    notifyTransferFailed(transferId, errorMsg, true)

    return {
      success: false,
      error: errorMsg,
    }
  }
}

/**
 * Retry failed/pending transfers with exponential backoff
 * Called periodically by a background job or on-demand
 */
export async function retryTransfer(transferId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const transfer = await getTransfer(transferId)

    if (!transfer) {
      return { success: false, error: 'Transfer not found' }
    }

    // Don't retry if already completed
    if (transfer.status === 'completed') {
      console.log('[Transfer] Transfer already completed, skipping retry')
      return { success: true }
    }

    // Check if max retries exceeded
    if (transfer.retry_count >= MAX_RETRY_ATTEMPTS) {
      console.warn('[Transfer] Max retries exceeded for transfer', transferId)
      await updateTransferStatus(
        transferId,
        'failed',
        undefined,
        `Failed after ${MAX_RETRY_ATTEMPTS} attempts`
      )
      notifyTransferFailed(transferId, `Failed after ${MAX_RETRY_ATTEMPTS} attempts`, false)
      return { success: false, error: 'Max retries exceeded' }
    }

    // Check if enough time has passed since last retry
    if (transfer.last_retry_at) {
      const timeSinceLastRetry = Date.now() - new Date(transfer.last_retry_at).getTime()
      const requiredDelay = RETRY_DELAYS[Math.min(transfer.retry_count, RETRY_DELAYS.length - 1)]

      if (timeSinceLastRetry < requiredDelay) {
        console.log('[Transfer] Not enough time passed since last retry', {
          transferId,
          timeSinceLastRetry,
          requiredDelay,
        })
        return { success: false, error: 'Too soon to retry' }
      }
    }

    // Notify retry attempt
    notifyTransferRetry(transferId, transfer.retry_count + 1, MAX_RETRY_ATTEMPTS)

    // Update status to processing
    await updateTransferStatus(transferId, 'processing')

    // Execute the transfer
    const result = await executeTransfer(
      transferId,
      transfer.merchant_address,
      transfer.amount,
      `FlashPay payout (Attempt ${transfer.retry_count + 1}/${MAX_RETRY_ATTEMPTS})`
    )

    if (!result.success) {
      console.error('[Transfer] Retry failed:', {
        transferId,
        error: result.error,
        retryCount: transfer.retry_count,
      })

      // Update to failed if max retries reached, otherwise leave as pending for next retry
      if (transfer.retry_count + 1 >= MAX_RETRY_ATTEMPTS) {
        await updateTransferStatus(
          transferId,
          'failed',
          undefined,
          result.error || 'Transfer failed'
        )
        notifyTransferFailed(transferId, `Failed after ${MAX_RETRY_ATTEMPTS} attempts`, false)
      }

      return { success: false, error: result.error }
    }

    console.log('[Transfer] Retry successful', { transferId, piTransferId: result.piTransferId })
    return { success: true }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    console.error('[Transfer] Retry logic failed:', errorMsg)
    return { success: false, error: errorMsg }
  }
}

/**
 * Process all pending/failed transfers with retry
 * Call this periodically (e.g., every 5 minutes) or from a background job
 */
export async function processPendingTransfers(): Promise<{
  processed: number
  successful: number
  failed: number
}> {
  try {
    const { getPendingTransfers } = await import('./db')
    const pendingTransfers = await getPendingTransfers(50)

    if (!pendingTransfers || pendingTransfers.length === 0) {
      console.log('[Transfer] No pending transfers to process')
      return { processed: 0, successful: 0, failed: 0 }
    }

    console.log('[Transfer] Processing', pendingTransfers.length, 'pending transfers')

    let successful = 0
    let failed = 0

    for (const transfer of pendingTransfers) {
      const result = await retryTransfer(transfer.id)
      if (result.success) {
        successful++
      } else {
        failed++
      }
    }

    console.log('[Transfer] Batch processing complete', {
      processed: pendingTransfers.length,
      successful,
      failed,
    })

    return {
      processed: pendingTransfers.length,
      successful,
      failed,
    }
  } catch (error) {
    console.error('[Transfer] Batch processing failed:', error)
    return { processed: 0, successful: 0, failed: 0 }
  }
}
