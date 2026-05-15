import { CoreLogger } from "./core"
import {
  recordSettlementTransfer,
  getPendingSettlements,
  updateSettlementStatus,
  getSettlementHistory,
  updateMerchantBalance,
  getMerchantBalance,
  query,
} from "./db"
import { config } from "./config"

/**
 * Settlement Service - Handles merchant payouts from app wallet
 * 
 * Flow:
 * 1. Payment completes → settlement_request queued
 * 2. Settlement service batches and processes payouts
 * 3. Pi API transfer called
 * 4. TXID recorded and status updated
 * 5. Merchant balance updated
 */

export interface SettlementRequest {
  id: string
  merchant_id: string
  transaction_id: string
  amount: number
  status: 'queued' | 'processing' | 'completed' | 'failed'
  created_at: string
  completed_at?: string
  txid?: string
  error_message?: string
  retry_count: number
  payment_id?: string
}

/**
 * Queue a settlement request after payment completes
 * Called from /api/pi/complete webhook
 */
export async function queueSettlementRequest(
  merchantId: string,
  transactionId: string,
  amount: number
): Promise<boolean> {
  try {
    CoreLogger.info('[Settlement] Queuing settlement request:', { merchantId, amount })

    const result = await recordSettlementTransfer(merchantId, transactionId, amount)

    if (!result) {
      CoreLogger.error('[Settlement] Failed to queue settlement request')
      return false
    }

    // Update merchant balance: add to unsettled
    const balance = await getMerchantBalance(merchantId)
    const newUnsettled = (balance?.unsettled || 0) + amount
    const settled = balance?.settled || 0

    await updateMerchantBalance(merchantId, settled, newUnsettled)

    CoreLogger.info('[Settlement] Settlement queued successfully:', { settlementId: result.id, unsettled: newUnsettled })
    return true
  } catch (error) {
    CoreLogger.error('[Settlement] Error queuing settlement:', error)
    return false
  }
}

/**
 * Process pending settlements for a merchant
 * Can be called manually or via scheduled task
 */
export async function processSettlementsForMerchant(merchantId: string): Promise<any> {
  try {
    CoreLogger.info('[Settlement] Processing settlements for merchant:', merchantId)

    const pendingSettlements = await getPendingSettlements(merchantId)

    if (!pendingSettlements || pendingSettlements.length === 0) {
      CoreLogger.info('[Settlement] No pending settlements for merchant:', merchantId)
      return { processed: 0, succeeded: 0, failed: 0 }
    }

    CoreLogger.info('[Settlement] Found pending settlements:', { count: pendingSettlements.length, merchantId })

    let succeeded = 0
    let failed = 0

    for (const settlement of pendingSettlements) {
      const result = await processSettlement(settlement, merchantId)
      if (result) {
        succeeded++
      } else {
        failed++
      }
    }

    CoreLogger.info('[Settlement] Processing complete:', { merchantId, succeeded, failed })
    return { processed: pendingSettlements.length, succeeded, failed }
  } catch (error) {
    CoreLogger.error('[Settlement] Error processing settlements:', error)
    return { processed: 0, succeeded: 0, failed: 0, error: String(error) }
  }
}

/**
 * Process a single settlement request
 */
async function processSettlement(settlement: SettlementRequest, merchantId: string): Promise<boolean> {
  try {
    CoreLogger.info('[Settlement] Processing settlement:', { settlementId: settlement.id, amount: settlement.amount })

    // Mark as processing
    await updateSettlementStatus(settlement.id, 'processing')

    // Call Pi SDK to transfer funds from app wallet to merchant wallet
    // NOTE: This requires merchant wallet address - would be stored in merchant profile
    const txid = await executePiTransfer(merchantId, settlement.amount)

    if (!txid) {
      CoreLogger.error('[Settlement] Pi transfer failed:', { settlementId: settlement.id })
      await updateSettlementStatus(
        settlement.id,
        settlement.retry_count < 3 ? 'queued' : 'failed',
        undefined,
        'Pi transfer API call failed'
      )
      return false
    }

    // Mark as completed with TXID
    await updateSettlementStatus(settlement.id, 'completed', txid)

    // Update merchant balance: move from unsettled to settled
    const balance = await getMerchantBalance(merchantId)
    const newSettled = (balance?.settled || 0) + settlement.amount
    const newUnsettled = Math.max(0, (balance?.unsettled || 0) - settlement.amount)

    await updateMerchantBalance(merchantId, newSettled, newUnsettled)

    CoreLogger.info('[Settlement] Settlement completed:', { settlementId: settlement.id, txid, settled: newSettled })
    return true
  } catch (error) {
    CoreLogger.error('[Settlement] Error processing settlement:', error)
    await updateSettlementStatus(
      settlement.id,
      settlement.retry_count < 3 ? 'queued' : 'failed',
      undefined,
      String(error)
    )
    return false
  }
}

/**
 * Execute Pi Network transfer from app wallet to merchant wallet
 * This calls the Pi SDK to transfer funds
 */
async function executePiTransfer(merchantId: string, amount: number): Promise<string | null> {
  try {
    // In production, you would:
    // 1. Retrieve merchant wallet address from merchant profile
    // 2. Call Pi API endpoint to create transfer
    // 3. Return TXID

    CoreLogger.info('[Settlement] Executing Pi transfer:', { merchantId, amount })

    // Get merchant wallet address (would be stored in database)
    const merchantAddress = await getMerchantAddress(merchantId)

    if (!merchantAddress) {
      CoreLogger.error('[Settlement] Merchant wallet address not found:', merchantId)
      return null
    }

    // Call Pi API (mock for now - would use real Pi SDK in production)
    const txid = await callPiPaymentAPI({
      amount,
      recipient: merchantAddress,
      memo: `FlashPay settlement for merchant ${merchantId}`,
    })

    CoreLogger.info('[Settlement] Pi transfer initiated:', { txid, amount, recipient: merchantAddress })
    return txid
  } catch (error) {
    CoreLogger.error('[Settlement] Pi transfer error:', error)
    return null
  }
}

/**
 * Get merchant wallet address
 * In production, this would query merchant profile from database
 */
async function getMerchantAddress(merchantId: string): Promise<string | null> {
  try {
    // TODO: Implement merchant profile table with wallet address
    // For now, return mock address
    CoreLogger.info('[Settlement] Getting merchant address for:', merchantId)
    
    // In production:
    // const result = await query(
    //   'SELECT pi_address FROM merchant_profiles WHERE merchant_id = $1',
    //   [merchantId]
    // )
    // return result?.[0]?.pi_address || null

    return `merchant_${merchantId}_pi_address`
  } catch (error) {
    CoreLogger.error('[Settlement] Error getting merchant address:', error)
    return null
  }
}

/**
 * Mock Pi Payment API call (would use real Pi SDK in production)
 */
async function callPiPaymentAPI(params: {
  amount: number
  recipient: string
  memo: string
}): Promise<string> {
  try {
    CoreLogger.info('[Settlement] Calling Pi API:', { amount: params.amount, recipient: params.recipient })

    // In production, this would call actual Pi API
    // For now, return a mock TXID
    const txid = `settlement_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    CoreLogger.info('[Settlement] Pi API response - TXID:', txid)
    return txid
  } catch (error) {
    CoreLogger.error('[Settlement] Pi API error:', error)
    throw error
  }
}

/**
 * Get settlement history for merchant dashboard
 */
export async function getMerchantSettlementHistory(merchantId: string, limit: number = 50) {
  try {
    const settlements = await getSettlementHistory(merchantId, limit)
    return settlements || []
  } catch (error) {
    CoreLogger.error('[Settlement] Error getting settlement history:', error)
    return []
  }
}

/**
 * Get settlement statistics for merchant
 */
export async function getSettlementStats(merchantId: string) {
  try {
    const balance = await getMerchantBalance(merchantId)
    const pending = await getPendingSettlements(merchantId)

    return {
      settled: balance?.settled || 0,
      unsettled: balance?.unsettled || 0,
      pendingCount: pending?.length || 0,
      lastUpdated: balance?.last_updated || new Date().toISOString(),
    }
  } catch (error) {
    CoreLogger.error('[Settlement] Error getting settlement stats:', error)
    return {
      settled: 0,
      unsettled: 0,
      pendingCount: 0,
      lastUpdated: new Date().toISOString(),
    }
  }
}
