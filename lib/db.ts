'use server'

import { randomUUID } from 'crypto'
import type {
  SettlementRequest,
  TransactionRow,
  ReceiptRow,
  MerchantBalanceRow,
  RefundCheckpoint,
  RefundAuditEvent,
} from './types'

// Database layer - handles PostgreSQL/Neon integration via postgres client
// Note: Functions that use database client are server-only

/**
 * Normalize PostgreSQL NUMERIC value to validated number.
 * PostgreSQL NUMERIC is returned as string or finite number; must be validated.
 * @throws Error if value is not a finite number or fully valid numeric string
 */
function normalizePostgresNumeric(value: unknown, fieldName: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${fieldName} is not finite: ${value}`)
    }
    return value
  }
  
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      throw new Error(`${fieldName} is empty string`)
    }
    const converted = Number(trimmed)
    if (!Number.isFinite(converted)) {
      throw new Error(`${fieldName} is not a valid finite number: "${value}"`)
    }
    return converted
  }
  
  throw new Error(`${fieldName} has unsupported type: ${typeof value}`)
}

// Singleton connection instance
let sqlClient: any = null
let initializationAttempted = false

// Get or create the postgres client connection
async function getPostgresClient() {
  // Return cached client if already initialized
  if (sqlClient !== null) {
    return sqlClient
  }

  // Return null if already tried and failed
  if (initializationAttempted) {
    return null
  }

  if (!process.env.DATABASE_URL) {
    console.warn('[DB] DATABASE_URL not configured, cannot initialize postgres client')
    initializationAttempted = true
    return null
  }

  try {
    console.log('[DB] Initializing postgres client...')
    // Import the postgres client
    const postgres = await import('postgres')
    const sql = postgres.default

    if (!sql) {
      console.error('[DB] Postgres client is not available from the module')
      initializationAttempted = true
      return null
    }

    // Create client instance with connection URL
    sqlClient = sql(process.env.DATABASE_URL)
    initializationAttempted = true
    console.log('[DB] Postgres client initialized successfully')
    return sqlClient
  } catch (error) {
    console.error('[DB] Failed to load postgres client:', error)
    initializationAttempted = true
    sqlClient = null
    return null
  }
}

export async function query(text: string, values?: unknown[]) {
  // Check if PostgreSQL is configured
  if (!process.env.DATABASE_URL) {
    console.warn('[DB] PostgreSQL not configured, query blocked')
    return null
  }

  try {
    const client = await getPostgresClient()
    if (!client) {
      console.error('[DB] Postgres client failed to initialize')
      return null
    }

    console.log('[DB] Executing query:', text.substring(0, 60) + '...')

    // Use parameterized query with postgres client
    let result: any

    if (values && values.length > 0) {
      // Postgres client handles parameterization automatically
      result = await client.unsafe(text, values)
    } else {
      result = await client.unsafe(text)
    }

    console.log('[DB] Query succeeded, rows:', result?.length || 0)
    return result as unknown[]
  } catch (error) {
    console.error('[DB] Query execution failed:', error)
    return null
  }
}

/**
 * Initialize database schema on first run
 */
/**
 * N-FIN-10A durable settlement authority schema.
 *
 * IMPORTANT: this stage is schema-only. No financial execution or recovery path
 * reads from or writes to this table yet. Later N-FIN-10 stages will add a single
 * monotonic CAS writer before any recovery cutover.
 */
export async function ensureSettlementCheckpointTable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false

  const table = await query(`
    CREATE TABLE IF NOT EXISTS settlement_checkpoints (
      payment_id TEXT PRIMARY KEY,
      version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
      stage TEXT NOT NULL CHECK (stage IN (
        'payment_identity',
        'a2u_created',
        'prepared',
        'horizon_confirmed',
        'pi_completed',
        'db_finalized'
      )),
      merchant_id TEXT NOT NULL CHECK (length(btrim(merchant_id)) > 0),
      merchant_uid TEXT NOT NULL CHECK (length(btrim(merchant_uid)) > 0),
      customer_amount NUMERIC(18, 8) NOT NULL CHECK (customer_amount > 0),
      merchant_amount NUMERIC(18, 8) CHECK (merchant_amount > 0),
      app_commission NUMERIC(18, 8) NOT NULL DEFAULT 0 CHECK (app_commission = 0),
      a2u_payment_id TEXT,
      a2u_from_address TEXT,
      a2u_to_address TEXT,
      prepared_envelope_xdr TEXT,
      prepared_tx_hash TEXT CHECK (prepared_tx_hash IS NULL OR prepared_tx_hash ~ '^[0-9a-f]{64}$'),
      prepared_sequence NUMERIC(30, 0) CHECK (prepared_sequence IS NULL OR prepared_sequence > 0),
      a2u_txid TEXT CHECK (a2u_txid IS NULL OR a2u_txid ~ '^[0-9a-f]{64}$'),
      horizon_fee_stroops BIGINT CHECK (horizon_fee_stroops IS NULL OR horizon_fee_stroops >= 0),
      horizon_confirmed_at TIMESTAMP,
      pi_completed_at TIMESTAMP,
      db_finalized_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CHECK (merchant_amount IS NULL OR merchant_amount = customer_amount),
      CHECK (
        stage NOT IN ('a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized')
        OR a2u_payment_id IS NOT NULL
      ),
      CHECK (
        stage NOT IN ('prepared','horizon_confirmed','pi_completed','db_finalized')
        OR (
          a2u_from_address IS NOT NULL AND
          a2u_to_address IS NOT NULL AND
          prepared_envelope_xdr IS NOT NULL AND
          prepared_tx_hash IS NOT NULL AND
          prepared_sequence IS NOT NULL
        )
      ),
      CHECK (
        stage NOT IN ('horizon_confirmed','pi_completed','db_finalized')
        OR (
          a2u_txid IS NOT NULL AND
          prepared_tx_hash = a2u_txid AND
          horizon_fee_stroops IS NOT NULL AND
          horizon_confirmed_at IS NOT NULL
        )
      ),
      CHECK (
        stage NOT IN ('pi_completed','db_finalized')
        OR pi_completed_at IS NOT NULL
      ),
      CHECK (
        stage <> 'db_finalized'
        OR db_finalized_at IS NOT NULL
      )
    )
  `)
  if (table === null) return false

  const stageIndex = await query(`
    CREATE INDEX IF NOT EXISTS idx_settlement_checkpoints_stage_updated
    ON settlement_checkpoints(stage, updated_at ASC)
  `)
  if (stageIndex === null) return false

  const a2uPaymentIndex = await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_checkpoints_a2u_payment_id
    ON settlement_checkpoints(a2u_payment_id)
    WHERE a2u_payment_id IS NOT NULL
  `)
  if (a2uPaymentIndex === null) return false

  const preparedHashIndex = await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_checkpoints_prepared_tx_hash
    ON settlement_checkpoints(prepared_tx_hash)
    WHERE prepared_tx_hash IS NOT NULL
  `)
  if (preparedHashIndex === null) return false

  const txidIndex = await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_checkpoints_a2u_txid
    ON settlement_checkpoints(a2u_txid)
    WHERE a2u_txid IS NOT NULL
  `)
  return txidIndex !== null
}

export type SettlementStage1CheckpointResult =
  | { outcome: 'RECORDED' | 'REPLAYED'; version: number }
  | { outcome: 'CONFLICT' | 'INDETERMINATE'; error: string }

/**
 * N-FIN-10B: first monotonic durable writer.
 *
 * Scope is deliberately limited to the A2U-created boundary. It may create a
 * checkpoint or replay the exact same checkpoint; it can never replace durable
 * identity, regress/advance a later stage, or authorize blockchain movement.
 */
export async function recordSettlementA2UCreatedCheckpoint(params: {
  paymentId: string
  merchantId: string
  merchantUid: string
  customerAmount: number
  merchantAmount: number
  a2uPaymentId: string
  a2uFromAddress: string
  a2uToAddress: string
}): Promise<SettlementStage1CheckpointResult> {
  const canonicalText = (value: string) => typeof value === 'string' && value.length > 0 && value === value.trim()
  if (
    !canonicalText(params.paymentId) ||
    !canonicalText(params.merchantId) ||
    !canonicalText(params.merchantUid) ||
    !canonicalText(params.a2uPaymentId) ||
    !canonicalText(params.a2uFromAddress) ||
    !canonicalText(params.a2uToAddress) ||
    typeof params.customerAmount !== 'number' ||
    !Number.isFinite(params.customerAmount) ||
    params.customerAmount <= 0 ||
    typeof params.merchantAmount !== 'number' ||
    !Number.isFinite(params.merchantAmount) ||
    params.merchantAmount !== params.customerAmount
  ) {
    return { outcome: 'CONFLICT', error: 'Settlement Stage1 checkpoint input is invalid' }
  }

  try {
    const client = await getPostgresClient()
    if (!client) return { outcome: 'INDETERMINATE', error: 'PostgreSQL unavailable' }

    const rows = await client.begin(async (tx: any) => {
      const inserted = await tx`
        INSERT INTO settlement_checkpoints (
          payment_id, version, stage, merchant_id, merchant_uid,
          customer_amount, merchant_amount, app_commission,
          a2u_payment_id, a2u_from_address, a2u_to_address
        )
        VALUES (
          ${params.paymentId}, 1, 'a2u_created', ${params.merchantId}, ${params.merchantUid},
          ${params.customerAmount}, ${params.merchantAmount}, 0,
          ${params.a2uPaymentId}, ${params.a2uFromAddress}, ${params.a2uToAddress}
        )
        ON CONFLICT DO NOTHING
        RETURNING version
      `
      if (inserted.length === 1) return [{ ...inserted[0], inserted: true }]

      // Replay is accepted only when every durable identity/accounting field is exact.
      // A later stage is intentionally accepted only if it carries this exact Stage1 identity.
      return await tx`
        SELECT version, stage, merchant_id, merchant_uid,
               customer_amount, merchant_amount, app_commission,
               a2u_payment_id, a2u_from_address, a2u_to_address,
               prepared_envelope_xdr, prepared_tx_hash, prepared_sequence,
               a2u_txid, horizon_fee_stroops, horizon_confirmed_at,
               pi_completed_at, db_finalized_at
        FROM settlement_checkpoints
        WHERE payment_id = ${params.paymentId}
           OR a2u_payment_id = ${params.a2uPaymentId}
        FOR UPDATE
      `
    })

    if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== 'object' || rows[0] === null) {
      return { outcome: 'CONFLICT', error: 'Settlement Stage1 durable identity is ambiguous or conflicting' }
    }
    const row = rows[0] as Record<string, unknown>
    const version = Number(row.version)
    if (!Number.isSafeInteger(version) || version < 1) {
      return { outcome: 'CONFLICT', error: 'Settlement Stage1 durable version is invalid' }
    }
    if (row.inserted === true) return { outcome: 'RECORDED', version }

    let storedCustomerAmount: number
    let storedMerchantAmount: number
    let storedAppCommission: number
    try {
      storedCustomerAmount = normalizePostgresNumeric(row.customer_amount, 'settlement.customer_amount')
      storedMerchantAmount = normalizePostgresNumeric(row.merchant_amount, 'settlement.merchant_amount')
      storedAppCommission = normalizePostgresNumeric(row.app_commission, 'settlement.app_commission')
    } catch {
      return { outcome: 'CONFLICT', error: 'Settlement Stage1 durable accounting is invalid' }
    }

    const validStage = typeof row.stage === 'string' && [
      'a2u_created', 'prepared', 'horizon_confirmed', 'pi_completed', 'db_finalized'
    ].includes(row.stage)
    if (
      !validStage ||
      row.merchant_id !== params.merchantId ||
      row.merchant_uid !== params.merchantUid ||
      storedCustomerAmount !== params.customerAmount ||
      storedMerchantAmount !== params.merchantAmount ||
      storedAppCommission !== 0 ||
      row.a2u_payment_id !== params.a2uPaymentId ||
      row.a2u_from_address !== params.a2uFromAddress ||
      row.a2u_to_address !== params.a2uToAddress
    ) {
      return { outcome: 'CONFLICT', error: 'Settlement Stage1 durable identity/accounting mismatch' }
    }
    return { outcome: 'REPLAYED', version }
  } catch (error) {
    console.error('[DB] Settlement Stage1 durable checkpoint outcome is uncertain:', error)
    return { outcome: 'INDETERMINATE', error: 'Settlement Stage1 durable checkpoint outcome is uncertain' }
  }
}

export type SettlementDurableAdvanceResult =
  | { outcome: 'RECORDED' | 'REPLAYED'; version: number }
  | { outcome: 'CONFLICT' | 'INDETERMINATE'; error: string }

export async function recordSettlementPreparedCheckpoint(params: {
  paymentId:string; merchantId:string; merchantUid:string; customerAmount:number; merchantAmount:number;
  a2uPaymentId:string; a2uFromAddress:string; a2uToAddress:string;
  preparedEnvelopeXdr:string; preparedTxHash:string; preparedSequence:string
}):Promise<SettlementDurableAdvanceResult>{
  if(!params.paymentId||!params.merchantId||!params.merchantUid||!params.a2uPaymentId||!params.a2uFromAddress||!params.a2uToAddress||
     !params.preparedEnvelopeXdr||params.preparedEnvelopeXdr!==params.preparedEnvelopeXdr.trim()||
     !/^[0-9a-f]{64}$/.test(params.preparedTxHash)||!/^[1-9][0-9]*$/.test(params.preparedSequence)||
     !Number.isFinite(params.customerAmount)||params.customerAmount<=0||!Number.isFinite(params.merchantAmount)||params.merchantAmount!==params.customerAmount)
    return {outcome:'CONFLICT',error:'Settlement prepared checkpoint input is invalid'}
  try{
    const client=await getPostgresClient();if(!client)return{outcome:'INDETERMINATE',error:'PostgreSQL unavailable'}
    const rows=await client.begin(async(tx:any)=>{
      const a=await tx`UPDATE settlement_checkpoints SET version=version+1,stage='prepared',
        prepared_envelope_xdr=${params.preparedEnvelopeXdr},prepared_tx_hash=${params.preparedTxHash},prepared_sequence=${params.preparedSequence},updated_at=NOW()
        WHERE payment_id=${params.paymentId} AND stage='a2u_created'
        AND merchant_id=${params.merchantId} AND merchant_uid=${params.merchantUid}
        AND customer_amount=${params.customerAmount} AND merchant_amount=${params.merchantAmount} AND app_commission=0
        AND a2u_payment_id=${params.a2uPaymentId} AND a2u_from_address=${params.a2uFromAddress} AND a2u_to_address=${params.a2uToAddress}
        AND prepared_envelope_xdr IS NULL AND prepared_tx_hash IS NULL AND prepared_sequence IS NULL
        AND a2u_txid IS NULL AND horizon_confirmed_at IS NULL RETURNING version,stage`
      if(a.length===1)return[{...a[0],advanced:true}]
      return await tx`SELECT version,stage,merchant_id,merchant_uid,customer_amount,merchant_amount,app_commission,
        a2u_payment_id,a2u_from_address,a2u_to_address,prepared_envelope_xdr,prepared_tx_hash,prepared_sequence,a2u_txid
        FROM settlement_checkpoints WHERE payment_id=${params.paymentId} OR a2u_payment_id=${params.a2uPaymentId} OR prepared_tx_hash=${params.preparedTxHash} FOR UPDATE`
    })
    if(!Array.isArray(rows)||rows.length!==1||!rows[0])return{outcome:'CONFLICT',error:'Settlement prepared durable identity is ambiguous or conflicting'}
    const r=rows[0] as Record<string,unknown>,v=Number(r.version);if(!Number.isSafeInteger(v)||v<2)return{outcome:'CONFLICT',error:'Settlement prepared durable version is invalid'}
    if(r.advanced===true)return{outcome:'RECORDED',version:v}
    let ca,ma,ac;try{ca=normalizePostgresNumeric(r.customer_amount,'settlement.customer_amount');ma=normalizePostgresNumeric(r.merchant_amount,'settlement.merchant_amount');ac=normalizePostgresNumeric(r.app_commission,'settlement.app_commission')}catch{return{outcome:'CONFLICT',error:'Settlement prepared durable accounting invalid'}}
    if(!(typeof r.stage==='string'&&['prepared','horizon_confirmed','pi_completed','db_finalized'].includes(r.stage))||
      r.merchant_id!==params.merchantId||r.merchant_uid!==params.merchantUid||ca!==params.customerAmount||ma!==params.merchantAmount||ac!==0||
      r.a2u_payment_id!==params.a2uPaymentId||r.a2u_from_address!==params.a2uFromAddress||r.a2u_to_address!==params.a2uToAddress||
      r.prepared_envelope_xdr!==params.preparedEnvelopeXdr||r.prepared_tx_hash!==params.preparedTxHash||String(r.prepared_sequence)!==params.preparedSequence)
      return{outcome:'CONFLICT',error:'Settlement prepared durable identity mismatch'}
    return{outcome:'REPLAYED',version:v}
  }catch(e){console.error('[DB] Settlement prepared checkpoint uncertain:',e);return{outcome:'INDETERMINATE',error:'Settlement prepared checkpoint uncertain'}}
}

export async function recordSettlementHorizonCheckpoint(params:{paymentId:string;a2uPaymentId:string;preparedTxHash:string;preparedSequence:string;a2uTxid:string;horizonFeeStroops:number}):Promise<SettlementDurableAdvanceResult>{
  if(!params.paymentId||!params.a2uPaymentId||!/^[0-9a-f]{64}$/.test(params.preparedTxHash)||!/^[1-9][0-9]*$/.test(params.preparedSequence)||
    params.a2uTxid!==params.preparedTxHash||!Number.isSafeInteger(params.horizonFeeStroops)||params.horizonFeeStroops<0)
    return{outcome:'CONFLICT',error:'Settlement Horizon checkpoint input invalid'}
  try{
    const client=await getPostgresClient();if(!client)return{outcome:'INDETERMINATE',error:'PostgreSQL unavailable'}
    const rows=await client.begin(async(tx:any)=>{
      const a=await tx`UPDATE settlement_checkpoints SET version=version+1,stage='horizon_confirmed',a2u_txid=${params.a2uTxid},
        horizon_fee_stroops=${params.horizonFeeStroops},horizon_confirmed_at=NOW(),updated_at=NOW()
        WHERE payment_id=${params.paymentId} AND stage='prepared' AND a2u_payment_id=${params.a2uPaymentId}
        AND prepared_tx_hash=${params.preparedTxHash} AND prepared_sequence=${params.preparedSequence}
        AND a2u_txid IS NULL AND horizon_fee_stroops IS NULL AND horizon_confirmed_at IS NULL RETURNING version,stage`
      if(a.length===1)return[{...a[0],advanced:true}]
      return await tx`SELECT version,stage,a2u_payment_id,prepared_tx_hash,prepared_sequence,a2u_txid,horizon_fee_stroops
        FROM settlement_checkpoints WHERE payment_id=${params.paymentId} OR a2u_payment_id=${params.a2uPaymentId} OR a2u_txid=${params.a2uTxid} FOR UPDATE`
    })
    if(!Array.isArray(rows)||rows.length!==1||!rows[0])return{outcome:'CONFLICT',error:'Settlement Horizon durable identity ambiguous'}
    const r=rows[0] as Record<string,unknown>,v=Number(r.version);if(!Number.isSafeInteger(v)||v<3)return{outcome:'CONFLICT',error:'Settlement Horizon durable version invalid'}
    if(r.advanced===true)return{outcome:'RECORDED',version:v}
    let fee;try{fee=normalizePostgresNumeric(r.horizon_fee_stroops,'settlement.horizon_fee_stroops')}catch{return{outcome:'CONFLICT',error:'Settlement Horizon durable fee invalid'}}
    if(!(typeof r.stage==='string'&&['horizon_confirmed','pi_completed','db_finalized'].includes(r.stage))||r.a2u_payment_id!==params.a2uPaymentId||
      r.prepared_tx_hash!==params.preparedTxHash||String(r.prepared_sequence)!==params.preparedSequence||r.a2u_txid!==params.a2uTxid||fee!==params.horizonFeeStroops)
      return{outcome:'CONFLICT',error:'Settlement Horizon durable evidence mismatch'}
    return{outcome:'REPLAYED',version:v}
  }catch(e){console.error('[DB] Settlement Horizon checkpoint uncertain:',e);return{outcome:'INDETERMINATE',error:'Settlement Horizon checkpoint uncertain'}}
}

export async function recordSettlementPiCompletedCheckpoint(params:{paymentId:string;a2uPaymentId:string;a2uTxid:string}):Promise<SettlementDurableAdvanceResult>{
  if(!params.paymentId||!params.a2uPaymentId||!/^[0-9a-f]{64}$/.test(params.a2uTxid))
    return{outcome:'CONFLICT',error:'Settlement Pi checkpoint input invalid'}
  try{
    const client=await getPostgresClient();if(!client)return{outcome:'INDETERMINATE',error:'PostgreSQL unavailable'}
    const rows=await client.begin(async(tx:any)=>{
      const a=await tx`UPDATE settlement_checkpoints SET version=version+1,stage='pi_completed',pi_completed_at=NOW(),updated_at=NOW()
        WHERE payment_id=${params.paymentId} AND stage='horizon_confirmed' AND a2u_payment_id=${params.a2uPaymentId}
        AND a2u_txid=${params.a2uTxid} AND prepared_tx_hash=${params.a2uTxid}
        AND horizon_confirmed_at IS NOT NULL AND pi_completed_at IS NULL RETURNING version,stage`
      if(a.length===1)return[{...a[0],advanced:true}]
      return await tx`SELECT version,stage,a2u_payment_id,a2u_txid,prepared_tx_hash,horizon_confirmed_at,pi_completed_at
        FROM settlement_checkpoints WHERE payment_id=${params.paymentId} OR a2u_payment_id=${params.a2uPaymentId} OR a2u_txid=${params.a2uTxid} FOR UPDATE`
    })
    if(!Array.isArray(rows)||rows.length!==1||!rows[0])return{outcome:'CONFLICT',error:'Settlement Pi durable identity ambiguous'}
    const r=rows[0] as Record<string,unknown>,v=Number(r.version);if(!Number.isSafeInteger(v)||v<4)return{outcome:'CONFLICT',error:'Settlement Pi durable version invalid'}
    if(r.advanced===true)return{outcome:'RECORDED',version:v}
    if(!(typeof r.stage==='string'&&['pi_completed','db_finalized'].includes(r.stage))||r.a2u_payment_id!==params.a2uPaymentId||
      r.a2u_txid!==params.a2uTxid||r.prepared_tx_hash!==params.a2uTxid||r.horizon_confirmed_at==null||r.pi_completed_at==null)
      return{outcome:'CONFLICT',error:'Settlement Pi durable evidence mismatch'}
    return{outcome:'REPLAYED',version:v}
  }catch(e){console.error('[DB] Settlement Pi checkpoint uncertain:',e);return{outcome:'INDETERMINATE',error:'Settlement Pi checkpoint uncertain'}}
}

export async function recordSettlementDbFinalizedCheckpoint(params:{
  paymentId:string;a2uPaymentId:string;a2uTxid:string;merchantId:string;merchantUid:string;
  customerAmount:number;merchantAmount:number;horizonFeeCharged:number;appCommission:number
}):Promise<SettlementDurableAdvanceResult>{
  const feeStroops=params.horizonFeeCharged*10_000_000
  if(!params.paymentId||!params.a2uPaymentId||!/^[0-9a-f]{64}$/.test(params.a2uTxid)||!params.merchantId||!params.merchantUid||
    !Number.isFinite(params.customerAmount)||params.customerAmount<=0||params.merchantAmount!==params.customerAmount||params.appCommission!==0||
    !Number.isSafeInteger(feeStroops)||feeStroops<0)return{outcome:'CONFLICT',error:'Settlement DB-finality input invalid'}
  try{
    const client=await getPostgresClient();if(!client)return{outcome:'INDETERMINATE',error:'PostgreSQL unavailable'}
    const rows=await client.begin(async(tx:any)=>{
      const a=await tx`UPDATE settlement_checkpoints SET version=version+1,stage='db_finalized',db_finalized_at=NOW(),updated_at=NOW()
        WHERE payment_id=${params.paymentId} AND stage='pi_completed' AND merchant_id=${params.merchantId} AND merchant_uid=${params.merchantUid}
        AND customer_amount=${params.customerAmount} AND merchant_amount=${params.merchantAmount} AND app_commission=0
        AND a2u_payment_id=${params.a2uPaymentId} AND a2u_txid=${params.a2uTxid} AND prepared_tx_hash=${params.a2uTxid}
        AND horizon_fee_stroops=${feeStroops} AND horizon_confirmed_at IS NOT NULL AND pi_completed_at IS NOT NULL AND db_finalized_at IS NULL
        AND EXISTS(SELECT 1 FROM receipts r WHERE r.u2a_identifier=${params.paymentId} AND r.a2u_identifier=${params.a2uPaymentId}
          AND r.a2u_txid=${params.a2uTxid} AND r.customer_amount=${params.customerAmount} AND r.merchant_amount=${params.merchantAmount}
          AND r.horizon_fee_charged=${params.horizonFeeCharged} AND r.app_commission=0)
        RETURNING version,stage`
      if(a.length===1)return[{...a[0],advanced:true}]
      return await tx`SELECT version,stage,merchant_id,merchant_uid,customer_amount,merchant_amount,app_commission,
        a2u_payment_id,a2u_txid,prepared_tx_hash,horizon_fee_stroops,pi_completed_at,db_finalized_at
        FROM settlement_checkpoints WHERE payment_id=${params.paymentId} OR a2u_payment_id=${params.a2uPaymentId} OR a2u_txid=${params.a2uTxid} FOR UPDATE`
    })
    if(!Array.isArray(rows)||rows.length!==1||!rows[0])return{outcome:'CONFLICT',error:'Settlement DB-finality durable identity ambiguous'}
    const r=rows[0] as Record<string,unknown>,v=Number(r.version);if(!Number.isSafeInteger(v)||v<5)return{outcome:'CONFLICT',error:'Settlement DB-finality durable version invalid'}
    if(r.advanced===true)return{outcome:'RECORDED',version:v}
    let ca,ma,ac,fs;try{ca=normalizePostgresNumeric(r.customer_amount,'settlement.customer_amount');ma=normalizePostgresNumeric(r.merchant_amount,'settlement.merchant_amount');ac=normalizePostgresNumeric(r.app_commission,'settlement.app_commission');fs=normalizePostgresNumeric(r.horizon_fee_stroops,'settlement.horizon_fee_stroops')}catch{return{outcome:'CONFLICT',error:'Settlement DB-finality durable accounting invalid'}}
    if(r.stage!=='db_finalized'||r.merchant_id!==params.merchantId||r.merchant_uid!==params.merchantUid||ca!==params.customerAmount||ma!==params.merchantAmount||ac!==0||
      r.a2u_payment_id!==params.a2uPaymentId||r.a2u_txid!==params.a2uTxid||r.prepared_tx_hash!==params.a2uTxid||fs!==feeStroops||r.pi_completed_at==null||r.db_finalized_at==null)
      return{outcome:'CONFLICT',error:'Settlement DB-finality durable evidence mismatch'}
    return{outcome:'REPLAYED',version:v}
  }catch(e){console.error('[DB] Settlement DB-finality checkpoint uncertain:',e);return{outcome:'INDETERMINATE',error:'Settlement DB-finality checkpoint uncertain'}}
}

export async function ensureRefundAccountingTable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false
  const result = await query(`
      CREATE TABLE IF NOT EXISTS refund_accounting_records (
        refund_id TEXT PRIMARY KEY REFERENCES refund_checkpoints(refund_id) ON DELETE RESTRICT,
        payment_id TEXT NOT NULL UNIQUE,
        refund_payment_id TEXT NOT NULL UNIQUE,
        refund_txid TEXT NOT NULL UNIQUE,
        payer_uid TEXT NOT NULL,
        amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
        horizon_fee_stroops BIGINT NOT NULL CHECK (horizon_fee_stroops >= 0),
        currency TEXT NOT NULL DEFAULT 'π',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)
  return result !== null
}

export async function initializeSchema() {
  if (!process.env.DATABASE_URL) {
    console.log('[DB] PostgreSQL not configured, skipping schema initialization')
    return
  }

  try {
    console.log('[DB] Creating database schema...')

    // Create transactions table
    await query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id TEXT NOT NULL UNIQUE,
        merchant_id TEXT NOT NULL,
        merchant_uid TEXT NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        currency TEXT DEFAULT 'π',
        reference TEXT NOT NULL UNIQUE,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP
      )
    `)

    // Create indexes for transactions
    await query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_merchant_created
      ON transactions(merchant_id, created_at DESC)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_created
      ON transactions(created_at DESC)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_payment_id
      ON transactions(payment_id)
    `)

    // Create receipts table with U2A and A2U identifiers
    await query(`
      CREATE TABLE IF NOT EXISTS receipts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL UNIQUE,
        merchant_id TEXT NOT NULL,
        merchant_uid TEXT NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        currency TEXT DEFAULT 'π',
        timestamp TIMESTAMP NOT NULL,
        txid TEXT,
        payer_username TEXT,
        u2a_identifier TEXT,
        u2a_txid TEXT,
        a2u_identifier TEXT,
        a2u_txid TEXT,
        metadata JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
      )
    `)

    // Create indexes for receipts
    await query(`
      CREATE INDEX IF NOT EXISTS idx_receipts_merchant
      ON receipts(merchant_id, created_at DESC)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_receipts_created
      ON receipts(created_at DESC)
    `)

    // Safely add merchant_uid column to transactions if it doesn't exist
    try {
      await query(`
        ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS merchant_uid TEXT NOT NULL DEFAULT ''
      `)
      console.log('[DB] merchant_uid column added to transactions (if needed)')
    } catch (e) {
      // Column may already exist or table may not exist yet, continue
      console.log('[DB] merchant_uid column migration for transactions (non-blocking):', (e as any).message?.substring(0, 100))
    }

    // Safely add merchant_uid column to receipts if it doesn't exist
    try {
      await query(`
        ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS merchant_uid TEXT NOT NULL DEFAULT ''
      `)
      console.log('[DB] merchant_uid column added to receipts (if needed)')
    } catch (e) {
      // Column may already exist or table may not exist yet, continue
      console.log('[DB] merchant_uid column migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    // Safely add U2A identifier columns to receipts
    try {
      await query(`
        ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS u2a_identifier TEXT
      `)
      console.log('[DB] u2a_identifier column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] u2a_identifier migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    try {
      await query(`
        ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS u2a_txid TEXT
      `)
      console.log('[DB] u2a_txid column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] u2a_txid migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    // Safely add A2U identifier columns to receipts
    try {
      await query(`
        ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS a2u_identifier TEXT
      `)
      console.log('[DB] a2u_identifier column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] a2u_identifier migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    try {
      await query(`
        ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS a2u_txid TEXT
      `)
      console.log('[DB] a2u_txid column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] a2u_txid migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    // Add fee and accounting tracking columns to receipts (each independently for idempotency)
    try {
      await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS customer_amount NUMERIC(18, 8)`)
      console.log('[DB] customer_amount column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] customer_amount migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    try {
      await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS horizon_fee_charged NUMERIC(18, 8) DEFAULT 0`)
      console.log('[DB] horizon_fee_charged column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] horizon_fee_charged migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    try {
      await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS app_commission NUMERIC(18, 8) DEFAULT 0`)
      console.log('[DB] app_commission column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] app_commission migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    try {
      await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS merchant_amount NUMERIC(18, 8)`)
      console.log('[DB] merchant_amount column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] merchant_amount migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    try {
      await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS app_net_impact NUMERIC(18, 8) DEFAULT 0`)
      console.log('[DB] app_net_impact column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] app_net_impact migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    try {
      await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS settlement_status TEXT DEFAULT 'pending'`)
      console.log('[DB] settlement_status column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] settlement_status migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    // Create merchant balances table
    await query(`
      CREATE TABLE IF NOT EXISTS merchant_balances (
        merchant_id TEXT PRIMARY KEY,
        settled NUMERIC(18, 8) DEFAULT 0,
        unsettled NUMERIC(18, 8) DEFAULT 0,
        last_updated TIMESTAMP DEFAULT NOW()
      )
    `)

    // Create index for merchant balances
    await query(`
      CREATE INDEX IF NOT EXISTS idx_merchant_balances_merchant
      ON merchant_balances(merchant_id)
    `)

    // Create settlement_requests table for tracking merchant payouts
    await query(`
      CREATE TABLE IF NOT EXISTS settlement_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        merchant_id TEXT NOT NULL,
        transaction_id UUID NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP,
        txid TEXT,
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
      )
    `)

    // N-FIN-10A: create the durable Settlement authority schema only.
    // No Settlement runtime path uses it until the later monotonic-writer stage.
    if (!(await ensureSettlementCheckpointTable())) {
      throw new Error('Settlement checkpoint schema initialization failed')
    }

    // Create durable refund intent/checkpoint records.
    // The unique payment and idempotency constraints prevent duplicate refunds.
    await query(`
      CREATE TABLE IF NOT EXISTS refund_checkpoints (
        refund_id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        payer_uid TEXT NOT NULL,
        payer_uid_verified_at TIMESTAMP NOT NULL,
        amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
        currency TEXT NOT NULL DEFAULT 'π',
        source_payment_status TEXT NOT NULL,
        source_settlement_state TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        refund_payment_id TEXT,
        refund_txid TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error_code TEXT,
        last_error_message TEXT,
        next_retry_at TIMESTAMP
      )
    `)

    await ensureRefundAccountingTable()

    await query(`
      CREATE TABLE IF NOT EXISTS refund_audit_events (
        event_id TEXT PRIMARY KEY,
        refund_id TEXT NOT NULL REFERENCES refund_checkpoints(refund_id) ON DELETE RESTRICT,
        payment_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_refund_checkpoints_status_retry
      ON refund_checkpoints(status, next_retry_at)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_refund_checkpoints_payment
      ON refund_checkpoints(payment_id)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_refund_audit_payment_created
      ON refund_audit_events(payment_id, created_at ASC)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_refund_audit_refund_created
      ON refund_audit_events(refund_id, created_at ASC)
    `)

    // Create indexes for settlement requests
    await query(`
      CREATE INDEX IF NOT EXISTS idx_settlement_requests_merchant_status
      ON settlement_requests(merchant_id, status)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_settlement_requests_created
      ON settlement_requests(created_at DESC)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_settlement_requests_status
      ON settlement_requests(status)
    `)

    console.log('[DB] Schema initialization complete')
  } catch (error) {
    console.error('[DB] Schema initialization error:', error)
    throw error
  }
}

/**
 * Ensure receipts table has all required accounting columns before transaction
 * MUST fail explicitly if any column cannot be added - not wrapped in try-catch
 * This is called before client.begin() to guarantee schema readiness
 */
export async function ensureReceiptsSchema() {
  if (!process.env.DATABASE_URL) {
    console.log('[DB] PostgreSQL not configured, skipping receipts schema check')
    return
  }

  console.log('[DB] Ensuring receipts table accounting columns exist...')

  // Each column add is separate and explicit - no nested try-catch during migration
  // If any fail, the error propagates to Stage 4 caller
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS customer_amount NUMERIC(18, 8)`)
  console.log('[DB] ✓ customer_amount column ensured')

  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS horizon_fee_charged NUMERIC(18, 8) DEFAULT 0`)
  console.log('[DB] ✓ horizon_fee_charged column ensured')

  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS app_commission NUMERIC(18, 8) DEFAULT 0`)
  console.log('[DB] ✓ app_commission column ensured')

  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS merchant_amount NUMERIC(18, 8)`)
  console.log('[DB] ✓ merchant_amount column ensured')

  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS app_net_impact NUMERIC(18, 8) DEFAULT 0`)
  console.log('[DB] ✓ app_net_impact column ensured')

  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS settlement_status TEXT DEFAULT 'pending'`)
  console.log('[DB] ✓ settlement_status column ensured')

  console.log('[DB] Receipts schema accounting columns verified')
}

/**
 * Get transaction by ID
 */
export async function getTransaction(transactionId: string): Promise<TransactionRow | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      'SELECT * FROM transactions WHERE id = $1',
      [transactionId]
    )
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as TransactionRow
  } catch (error) {
    console.error('[DB] getTransaction failed:', error)
    return null
  }
}

/**
 * Get receipt by transaction ID (includes transaction reference and description)
 */
export async function getReceipt(transactionId: string): Promise<ReceiptRow | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      `SELECT 
        r.*,
        t.reference,
        t.description,
        t.merchant_id,
        t.payment_id
      FROM receipts r
      LEFT JOIN transactions t ON r.transaction_id = t.id
      WHERE r.transaction_id = $1`,
      [transactionId]
    )
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as ReceiptRow
  } catch (error) {
    console.error('[DB] getReceipt failed:', error)
    return null
  }
}

/**
 * Get receipt by verified Pi U2A payment identifier.
 * This is an internal linkage helper only; the public/user-facing identifier
 * remains the FlashPay application payment ID.
 */
export async function getReceiptByU2AIdentifier(u2aIdentifier: string): Promise<ReceiptRow | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      `SELECT
        r.*,
        t.reference,
        t.description,
        t.merchant_id,
        t.payment_id
      FROM transactions t
      INNER JOIN receipts r ON r.transaction_id = t.id
      WHERE t.payment_id = $1`,
      [u2aIdentifier]
    )
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as ReceiptRow
  } catch (error) {
    console.error('[DB] getReceiptByU2AIdentifier failed:', error)
    return null
  }
}

/**
 * Get transactions by merchant with date range
 */
export async function getTransactionsByMerchant(
  merchantId: string,
  options: {
    fromDate?: Date
    toDate?: Date
    limit?: number
    offset?: number
  } = {}
) {
  if (!process.env.DATABASE_URL) return { transactions: [], total: 0 }

  try {
    const limit = options.limit || 50
    const offset = options.offset || 0

    // Build WHERE clause with date filters - qualify all with t
    let whereClause = 'WHERE t.merchant_id = $1'
    const params: any[] = [merchantId]
    let paramIndex = 2

    if (options.fromDate) {
      whereClause += ` AND t.created_at >= $${paramIndex}`
      params.push(options.fromDate)
      paramIndex++
    }

    if (options.toDate) {
      whereClause += ` AND t.created_at <= $${paramIndex}`
      params.push(options.toDate)
      paramIndex++
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM transactions t ${whereClause}`
    const countResult = await query(countQuery, params)
    
    // Validate and convert count
    let total = 0
    if (Array.isArray(countResult) && countResult.length > 0) {
      const row = countResult[0] as unknown
      if (typeof row === 'object' && row !== null) {
        const rowObj = row as Record<string, unknown>
        const countNum = Number(rowObj.count)
        if (Number.isFinite(countNum) && countNum >= 0) {
          total = countNum
        }
      }
    }

    // Get paginated results with receipt LEFT JOIN
    const transactionsQuery = `
      SELECT 
        t.id,
        t.payment_id,
        t.merchant_id,
        t.amount,
        t.currency,
        t.description,
        t.reference,
        t.created_at,
        t.completed_at,
        t.status,
        r.settlement_status,
        r.u2a_identifier,
        r.u2a_txid,
        r.a2u_identifier,
        r.a2u_txid
      FROM transactions t
      LEFT JOIN receipts r ON r.transaction_id = t.id
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `
    const paginationParams = [...params, limit, offset]
    const transactionsResult = await query(transactionsQuery, paginationParams)

    return {
      transactions: transactionsResult || [],
      total,
    }
  } catch (error) {
    console.error('[DB] getTransactionsByMerchant failed:', error)
    return { transactions: [], total: 0 }
  }
}

/**
 * Get merchant balance
 */
export async function getMerchantBalance(merchantId: string): Promise<MerchantBalanceRow | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      'SELECT * FROM merchant_balances WHERE merchant_id = $1',
      [merchantId]
    )
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as MerchantBalanceRow
  } catch (error) {
    console.error('[DB] getMerchantBalance failed:', error)
    return null
  }
}

/**
 * Get merchant payment dashboard summary statistics
 * Read-only query: transactions LEFT JOIN receipts for settlement tracking
 * Returns 14 normalized numeric values or null on any error
 */
export async function getMerchantPaymentDashboardSummary(
  merchantId: string
): Promise<{
  total_requests: number
  total_payment_volume: number
  settled_transactions: number
  total_settled_amount: number
  pending_transactions: number
  total_awaiting_amount: number
  failed_transactions: number
  total_failed_amount: number
  cancelled_transactions: number
  total_cancelled_amount: number
  completed_transactions: number
  total_completed_amount: number
  other_transactions: number
  total_other_amount: number
} | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    // Parameterized CTE: transactions LEFT JOIN receipts, use r.settlement_status as single source of truth
    const result = await query(
      `WITH payment_summary AS (
        SELECT 
          COUNT(*) as total_requests,
          COALESCE(SUM(t.amount), 0) as total_payment_volume,
          COUNT(CASE WHEN r.settlement_status = 'settled_to_merchant' THEN 1 END) as settled_transactions,
          COALESCE(SUM(CASE WHEN r.settlement_status = 'settled_to_merchant' THEN t.amount ELSE NULL END), 0) as total_settled_amount,
          COUNT(CASE WHEN r.settlement_status IN ('settlement_pending', 'paid_to_app', 'pending') THEN 1 END) as pending_transactions,
          COALESCE(SUM(CASE WHEN r.settlement_status IN ('settlement_pending', 'paid_to_app', 'pending') THEN t.amount ELSE NULL END), 0) as total_awaiting_amount,
          COUNT(CASE WHEN r.settlement_status IN ('failed', 'settlement_failed') THEN 1 END) as failed_transactions,
          COALESCE(SUM(CASE WHEN r.settlement_status IN ('failed', 'settlement_failed') THEN t.amount ELSE NULL END), 0) as total_failed_amount,
          COUNT(CASE WHEN r.settlement_status = 'cancelled' THEN 1 END) as cancelled_transactions,
          COALESCE(SUM(CASE WHEN r.settlement_status = 'cancelled' THEN t.amount ELSE NULL END), 0) as total_cancelled_amount,
          COUNT(CASE WHEN r.settlement_status = 'completed' THEN 1 END) as completed_transactions,
          COALESCE(SUM(CASE WHEN r.settlement_status = 'completed' THEN t.amount ELSE NULL END), 0) as total_completed_amount,
          COUNT(CASE WHEN r.settlement_status IS NULL OR r.settlement_status NOT IN ('settled_to_merchant', 'pending', 'paid_to_app', 'settlement_pending', 'failed', 'settlement_failed', 'cancelled', 'completed') THEN 1 END) as other_transactions,
          COALESCE(SUM(CASE WHEN r.settlement_status IS NULL OR r.settlement_status NOT IN ('settled_to_merchant', 'pending', 'paid_to_app', 'settlement_pending', 'failed', 'settlement_failed', 'cancelled', 'completed') THEN t.amount ELSE NULL END), 0) as total_other_amount
        FROM transactions t
        LEFT JOIN receipts r ON r.transaction_id = t.id
        WHERE t.merchant_id = $1
      )
      SELECT * FROM payment_summary`,
      [merchantId]
    )

    // Require array length 1
    if (!Array.isArray(result) || result.length !== 1) {
      console.error('[DB] getMerchantPaymentDashboardSummary: query returned non-array or wrong length')
      return null
    }

    const candidate = result[0]
    // Require row to be non-null object, not array
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      console.error('[DB] getMerchantPaymentDashboardSummary: row is null, non-object, or array')
      return null
    }

    const row = candidate as Record<string, unknown>

    // Normalize all 14 values via normalizePostgresNumeric
    try {
      return {
        total_requests: normalizePostgresNumeric(row.total_requests, 'total_requests'),
        total_payment_volume: normalizePostgresNumeric(row.total_payment_volume, 'total_payment_volume'),
        settled_transactions: normalizePostgresNumeric(row.settled_transactions, 'settled_transactions'),
        total_settled_amount: normalizePostgresNumeric(row.total_settled_amount, 'total_settled_amount'),
        pending_transactions: normalizePostgresNumeric(row.pending_transactions, 'pending_transactions'),
        total_awaiting_amount: normalizePostgresNumeric(row.total_awaiting_amount, 'total_awaiting_amount'),
        failed_transactions: normalizePostgresNumeric(row.failed_transactions, 'failed_transactions'),
        total_failed_amount: normalizePostgresNumeric(row.total_failed_amount, 'total_failed_amount'),
        cancelled_transactions: normalizePostgresNumeric(row.cancelled_transactions, 'cancelled_transactions'),
        total_cancelled_amount: normalizePostgresNumeric(row.total_cancelled_amount, 'total_cancelled_amount'),
        completed_transactions: normalizePostgresNumeric(row.completed_transactions, 'completed_transactions'),
        total_completed_amount: normalizePostgresNumeric(row.total_completed_amount, 'total_completed_amount'),
        other_transactions: normalizePostgresNumeric(row.other_transactions, 'other_transactions'),
        total_other_amount: normalizePostgresNumeric(row.total_other_amount, 'total_other_amount'),
      }
    } catch (err) {
      console.error('[DB] getMerchantPaymentDashboardSummary: normalization failed:', err)
      return null
    }
  } catch (error) {
    console.error('[DB] getMerchantPaymentDashboardSummary failed:', error)
    return null
  }
}

/**
 * Get merchant profile summary with transaction statistics
 * Read-only query: transactions LEFT JOIN receipts for settlement tracking
 */
export async function getSettledPaymentIds(merchantId: string, piPaymentIds: string[]): Promise<Set<string>> {
  if (!process.env.DATABASE_URL || piPaymentIds.length === 0) return new Set()

  try {
    const result = await query(
      `SELECT t.payment_id
       FROM transactions t
       JOIN receipts r ON r.transaction_id = t.id
       WHERE t.merchant_id = $1
         AND r.settlement_status = $2
         AND t.payment_id = ANY($3::text[])`,
      [merchantId, "settled_to_merchant", piPaymentIds],
    )

    const settledIds = new Set<string>()
    for (const row of result || []) {
      if (row && typeof row === "object") {
        const paymentId = (row as Record<string, unknown>).payment_id
        if (typeof paymentId === "string") settledIds.add(paymentId)
      }
    }
    return settledIds
  } catch (error) {
    console.error("[DB] getSettledPaymentIds failed:", error)
    return new Set()
  }
}

export async function getMerchantProfileSummary(merchantId: string): Promise<{
  totalTransactions: number
  settledTransactions: number
  totalSettledAmount: number
  pendingTransactions: number
  totalAwaitingAmount: number
  failedTransactions: number
  totalFailedAmount: number
  cancelledTransactions: number
  totalCancelledAmount: number
  completedTransactions: number
  totalCompletedAmount: number
  latestTransaction: {
    transactionId: string
    amount: number
    reference: string
    createdAt: string
    settlementStatus: string | null
  } | null
} | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    // Reuse the dashboard summary as the single raw accounting projection for
    // Profile and Payment Dashboard so their all-time counts/amounts cannot drift.
    const dashboardSummary = await getMerchantPaymentDashboardSummary(merchantId)
    if (!dashboardSummary) return null

    // Get latest transaction
    const latestResult = await query(
      `SELECT 
        t.id as transaction_id,
        t.amount,
        t.reference,
        t.created_at,
        r.settlement_status
      FROM transactions t
      LEFT JOIN receipts r ON r.transaction_id = t.id
      WHERE t.merchant_id = $1
      ORDER BY t.created_at DESC
      LIMIT 1`,
      [merchantId]
    )

    let latestTransaction: {
      transactionId: string
      amount: number
      reference: string
      createdAt: string
      settlementStatus: string | null
    } | null = null

    if (Array.isArray(latestResult) && latestResult.length > 0) {
      const latestRow = latestResult[0] as Record<string, unknown>
      if (typeof latestRow === 'object' && latestRow !== null) {
        // Validate required string fields: transaction_id and reference
        if (
          typeof latestRow.transaction_id !== 'string' ||
          typeof latestRow.reference !== 'string'
        ) {
          return null
        }

        // Validate and convert created_at: Date | string
        const createdAtValue = latestRow.created_at
        if (!(createdAtValue instanceof Date) && typeof createdAtValue !== 'string') {
          return null
        }

        const createdAtTime = createdAtValue instanceof Date
          ? createdAtValue.getTime()
          : new Date(createdAtValue).getTime()

        if (!Number.isFinite(createdAtTime)) {
          return null
        }

        latestTransaction = {
          transactionId: latestRow.transaction_id,
          amount: normalizePostgresNumeric(latestRow.amount, 'latest.amount'),
          reference: latestRow.reference,
          createdAt: new Date(createdAtTime).toISOString(),
          settlementStatus: typeof latestRow.settlement_status === 'string' ? latestRow.settlement_status : null,
        }
      }
    }

    return {
      totalTransactions: dashboardSummary.total_requests,
      settledTransactions: dashboardSummary.settled_transactions,
      totalSettledAmount: dashboardSummary.total_settled_amount,
      pendingTransactions: dashboardSummary.pending_transactions,
      totalAwaitingAmount: dashboardSummary.total_awaiting_amount,
      failedTransactions: dashboardSummary.failed_transactions,
      totalFailedAmount: dashboardSummary.total_failed_amount,
      cancelledTransactions: dashboardSummary.cancelled_transactions,
      totalCancelledAmount: dashboardSummary.total_cancelled_amount,
      completedTransactions: dashboardSummary.completed_transactions,
      totalCompletedAmount: dashboardSummary.total_completed_amount,
      latestTransaction,
    }
  } catch (error) {
    console.error('[DB] getMerchantProfileSummary failed:', error)
    return null
  }
}

/**
 * Update merchant balance
 */
export async function updateMerchantBalance(
  merchantId: string,
  settled: number,
  unsettled: number
): Promise<MerchantBalanceRow | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      `INSERT INTO merchant_balances (merchant_id, settled, unsettled, last_updated)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (merchant_id) DO UPDATE
       SET settled = merchant_balances.settled + EXCLUDED.settled,
           unsettled = merchant_balances.unsettled + EXCLUDED.unsettled,
           last_updated = NOW()
       RETURNING *`,
      [merchantId, settled, unsettled]
    )
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as MerchantBalanceRow
  } catch (error) {
    console.error('[DB] updateMerchantBalance failed:', error)
    return null
  }
}

/**
 * Record a settlement transfer to merchant
 */
export async function recordSettlementTransfer(
  merchantId: string,
  transactionId: string,
  amount: number,
  txid?: string
): Promise<SettlementRequest | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      `INSERT INTO settlement_requests
       (merchant_id, transaction_id, amount, status, created_at)
       VALUES ($1, $2, $3, 'queued', NOW())
       RETURNING *`,
      [merchantId, transactionId, amount]
    )

    console.log('[DB] Settlement request queued', { merchantId, amount })
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as SettlementRequest
  } catch (error) {
    console.error('[DB] Settlement request failed:', error)
    return null
  }
}

/**
 * Get pending settlements for a merchant
 * Validates and normalizes each row to SettlementRequest type
 */
export async function getPendingSettlements(merchantId: string): Promise<SettlementRequest[]> {
  if (!process.env.DATABASE_URL) return []

  try {
    const result = await query(
      `SELECT sr.*, t.payment_id 
       FROM settlement_requests sr
       LEFT JOIN transactions t ON sr.transaction_id = t.id
       WHERE sr.merchant_id = $1 AND sr.status IN ('queued', 'processing')
       ORDER BY sr.created_at ASC`,
      [merchantId]
    )

    if (!result || result.length === 0) return []

    // Validate and normalize each row
    const validated: SettlementRequest[] = []
    for (const row of result) {
      const unknown = row as unknown
      
      // Validate required string fields
      if (typeof unknown !== 'object' || unknown === null) continue
      const obj = unknown as Record<string, unknown>
      
      if (typeof obj.id !== 'string') continue
      if (typeof obj.merchant_id !== 'string') continue
      if (typeof obj.transaction_id !== 'string') continue
      if (typeof obj.status !== 'string') continue
      if (typeof obj.created_at !== 'string') continue
      
      // Validate allowed status union
      const status = obj.status as string
      if (!['queued', 'processing', 'completed', 'failed'].includes(status)) continue
      
      // Convert amount with validation
      const amountNum = Number(obj.amount)
      if (!Number.isFinite(amountNum)) continue
      
      // Convert retry_count with validation
      const retryNum = Number(obj.retry_count ?? 0)
      if (!Number.isFinite(retryNum)) continue
      
      validated.push({
        id: obj.id,
        merchant_id: obj.merchant_id,
        transaction_id: obj.transaction_id,
        amount: amountNum,
        status: status as 'queued' | 'processing' | 'completed' | 'failed',
        created_at: obj.created_at,
        completed_at: typeof obj.completed_at === 'string' ? obj.completed_at : undefined,
        txid: typeof obj.txid === 'string' ? obj.txid : undefined,
        error_message: typeof obj.error_message === 'string' ? obj.error_message : undefined,
        retry_count: retryNum,
        payment_id: typeof obj.payment_id === 'string' ? obj.payment_id : undefined,
      })
    }

    return validated
  } catch (error) {
    console.error('[DB] getPendingSettlements failed:', error)
    return []
  }
}

/**
 * Update settlement status and txid
 */
export async function updateSettlementStatus(
  settlementId: string,
  status: 'queued' | 'processing' | 'completed' | 'failed',
  txid?: string,
  errorMessage?: string
): Promise<SettlementRequest | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const updates: string[] = ['status = $2', 'retry_count = retry_count + 1']
    const params: unknown[] = [settlementId, status]
    let paramIndex = 3

    if (status === 'completed') {
      updates.push(`completed_at = NOW()`)
      if (txid) {
        updates.push(`txid = $${paramIndex}`)
        params.push(txid)
        paramIndex++
      }
    }

    if (status === 'failed' && errorMessage) {
      updates.push(`error_message = $${paramIndex}`)
      params.push(errorMessage)
      paramIndex++
    }

    const result = await query(
      `UPDATE settlement_requests 
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING *`,
      params
    )

    console.log('[DB] Settlement status updated:', { settlementId, status, txid })
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as SettlementRequest
  } catch (error) {
    console.error('[DB] updateSettlementStatus failed:', error)
    return null
  }
}

/**
 * Get settlement history for merchant
 */
export async function getSettlementHistory(merchantId: string, limit: number = 50) {
  if (!process.env.DATABASE_URL) return []

  try {
    const result = await query(
      `SELECT sr.*, t.payment_id, t.created_at as payment_date
       FROM settlement_requests sr
       LEFT JOIN transactions t ON sr.transaction_id = t.id
       WHERE sr.merchant_id = $1
       ORDER BY sr.created_at DESC
       LIMIT $2`,
      [merchantId, limit]
    )
    return result || []
  } catch (error) {
    console.error('[DB] getSettlementHistory failed:', error)
    return []
  }
}

/**
 * Record A2U transaction atomically after funds reach merchant wallet
 * Inserts transaction, receipt, updates merchant balance, and stores payment IDs/txids
 * Uses transaction-scoped client for true ACID guarantees - all or nothing
 */
export async function recordA2UTransactionAtomic(params: {
  u2aIdentifier: string      // U2A identifier from Pi webhook (identifier field)
  u2aTxid: string            // clientTxid from U2A flow
  a2uIdentifier: string      // A2U identifier from A2U response
  a2uTxid: string            // Horizon transaction ID from A2U flow
  merchantId: string
  merchantUid: string
  customerAmount: number     // Verified U2A amount (what customer sent)
  merchantAmount: number     // Actual amount in A2U blockchain transfer (what was sent on Stellar)
  horizonFeeCharged: number  // Actual submitResult.fee_charged / 10_000_000 (in Pi)
  appCommission: number      // REQUIRED: App commission (must be explicit, no fallback)
  note?: string
  createdAt?: Date
}): Promise<
  | { success: true; transactionId: string; transaction: { u2aIdentifier: string; u2aTxid: string; a2uIdentifier: string; a2uTxid: string; merchantId: string; merchantUid: string } }
  | { success: false; error: string }
> {
  // STRICT VALIDATION: Reject transaction if any required field is missing or invalid
  
  // Validate identifiers - must not be empty strings
  if (!params.u2aIdentifier || typeof params.u2aIdentifier !== 'string') {
    throw new Error('u2aIdentifier is required and must be a non-empty string')
  }
  if (!params.u2aTxid || typeof params.u2aTxid !== 'string') {
    throw new Error('u2aTxid is required and must be a non-empty string')
  }
  if (!params.a2uIdentifier || typeof params.a2uIdentifier !== 'string') {
    throw new Error('a2uIdentifier is required and must be a non-empty string')
  }
  if (!params.a2uTxid || typeof params.a2uTxid !== 'string') {
    throw new Error('a2uTxid is required and must be a non-empty string')
  }
  
  // Validate merchant identifiers
  if (!params.merchantId || typeof params.merchantId !== 'string') {
    throw new Error('merchantId is required and must be a non-empty string')
  }
  if (!params.merchantUid || typeof params.merchantUid !== 'string') {
    throw new Error('merchantUid is required and must be a non-empty string')
  }
  
  // CRITICAL: Use actual amounts from blockchain, not calculated amounts
  const customerAmount = params.customerAmount
  const merchantAmount = params.merchantAmount
  const horizonFeeCharged = params.horizonFeeCharged
  
  // Validate all amounts are finite numbers (no NaN, Infinity, or null)
  if (typeof customerAmount !== 'number' || !Number.isFinite(customerAmount)) {
    throw new Error('customerAmount must be a finite number')
  }
  if (typeof merchantAmount !== 'number' || !Number.isFinite(merchantAmount)) {
    throw new Error('merchantAmount must be a finite number')
  }
  if (typeof horizonFeeCharged !== 'number' || !Number.isFinite(horizonFeeCharged)) {
    throw new Error('horizonFeeCharged must be a finite number')
  }
  
  // CRITICAL: appCommission is REQUIRED, no fallback to 0
  // Must be an explicit number (not undefined, not null, not || 0)
  if (typeof params.appCommission !== 'number' || !Number.isFinite(params.appCommission)) {
    throw new Error('appCommission is required and must be a finite number')
  }
  const appCommission = params.appCommission
  
  // Calculate app net impact: what the app absorbs (may be negative if app bears fees)
  // appNetImpact = customerAmount - merchantAmount - horizonFeeCharged
  // The merchant is credited ONLY with merchantAmount (actual blockchain transfer)
  const appNetImpact = customerAmount - merchantAmount - horizonFeeCharged
  
  console.log('[DB] Accounting breakdown:')
  console.log('[DB]   - customerAmount:', customerAmount, '(what customer sent)')
  console.log('[DB]   - merchantAmount:', merchantAmount, '(actual blockchain transfer to merchant)')
  console.log('[DB]   - horizonFeeCharged:', horizonFeeCharged, '(actual Horizon fee)')
  console.log('[DB]   - appCommission:', appCommission)
  console.log('[DB]   - appNetImpact:', appNetImpact, '(app absorbs this: may be negative if app bears fees)')
  if (!process.env.DATABASE_URL) {
    console.error('[DB] PostgreSQL not configured for A2U transaction')
    return { success: false, error: 'Database not configured' }
  }

  try {
    console.log('[DB] Starting atomic A2U transaction:', {
      u2aIdentifier: params.u2aIdentifier,
      a2uIdentifier: params.a2uIdentifier,
      a2uTxid: params.a2uTxid,
      merchantId: params.merchantId,
      customerAmount: customerAmount,
      merchantAmount: merchantAmount,
      horizonFeeCharged: horizonFeeCharged,
    })

    const transactionId = randomUUID()
    const reference = `PAY-${new Date().getFullYear()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`
    const createdAtDate = params.createdAt || new Date()

    // Import postgres and create actual client from DATABASE_URL
    const postgres = await import('postgres')
    const sql = postgres.default
    if (!sql || !process.env.DATABASE_URL) {
      return { success: false, error: 'PostgreSQL client unavailable' }
    }

    const client = sql(process.env.DATABASE_URL)
    
    try {
      // Use postgres transaction callback API (no manual BEGIN/COMMIT/ROLLBACK)
      const result = await client.begin(async (tx) => {
        // 0. Check for existing transaction - if found, verify it matches identifiers and amounts (idempotency check)
        const existingTxCheck = await tx`
          SELECT id, merchant_id, merchant_uid, amount FROM transactions WHERE payment_id = ${params.u2aIdentifier}
          LIMIT 1
        `
        
        if (existingTxCheck && existingTxCheck.length > 0) {
          const existing = existingTxCheck[0]
          // IDEMPOTENCY: Verify the existing transaction matches merchant identity and canonical amount
          if (existing.merchant_id !== params.merchantId) {
            throw new Error(`Idempotency violation: existing transaction has different merchantId: ${existing.merchant_id} vs ${params.merchantId}`)
          }
          if (existing.merchant_uid !== params.merchantUid) {
            throw new Error(`Idempotency violation: existing transaction has different merchantUid: ${existing.merchant_uid} vs ${params.merchantUid}`)
          }
          // Normalize PostgreSQL NUMERIC to validated number for exact comparison
          const storedAmount = normalizePostgresNumeric(existing.amount, 'existing.amount')
          if (storedAmount !== merchantAmount) {
            throw new Error(`Idempotency violation: existing transaction has different amount: ${storedAmount} vs ${merchantAmount}`)
          }
          console.log('[DB] Idempotency check passed - existing transaction matches all fields, reusing transaction ID')
        }
        
        // 1. Upsert transaction with RETURNING id to get actual ID (new or existing)
        // CRITICAL: Store merchantAmount (actual blockchain transfer), NOT customerAmount
        const txResult = await tx`
          INSERT INTO transactions (
            id, payment_id, merchant_id, merchant_uid, amount, currency, 
            reference, description, status, created_at, completed_at
          ) VALUES (${transactionId}, ${params.u2aIdentifier}, ${params.merchantId}, ${params.merchantUid}, 
                    ${merchantAmount}, ${'π'}, ${reference}, ${params.note || 'A2U Settlement'}, 
                    ${'completed'}, ${createdAtDate.toISOString()}, NOW())
          ON CONFLICT (payment_id) DO UPDATE SET completed_at = NOW()
          RETURNING id
        `
        
        // Get the actual transaction ID (new or existing)
        const actualTransactionId = txResult[0]?.id || transactionId
        
        // 2. Insert receipt idempotently with fee tracking using the actual transaction ID
        // CRITICAL: Store customerAmount, merchantAmount (what was actually sent on blockchain), and horizonFeeCharged
        // On conflict, verify amounts match (idempotency check)
        // All required columns must exist before transaction begins
        const existingReceiptCheck = await tx`
          SELECT id, customer_amount, horizon_fee_charged, app_commission, merchant_amount,
                 u2a_identifier, u2a_txid, a2u_identifier, a2u_txid
          FROM receipts
          WHERE transaction_id = ${actualTransactionId} LIMIT 1
        `
        
        if (existingReceiptCheck.length > 0) {
          const existing = existingReceiptCheck[0]
          // IDEMPOTENCY: Verify existing receipt matches every stored accounting amount exactly
          // Normalize all PostgreSQL NUMERIC values to validated numbers for precise comparison
          const storedCustomerAmount = normalizePostgresNumeric(existing.customer_amount, 'existing.customer_amount')
          const storedMerchantAmount = normalizePostgresNumeric(existing.merchant_amount, 'existing.merchant_amount')
          const storedHorizonFeeCharged = normalizePostgresNumeric(existing.horizon_fee_charged, 'existing.horizon_fee_charged')
          const storedAppCommission = normalizePostgresNumeric(existing.app_commission, 'existing.app_commission')


          // N-FIN-9: replay is valid only for the exact same durable financial identity.
          if (existing.u2a_identifier !== params.u2aIdentifier) {
            throw new Error('Idempotency violation: receipt has different u2aIdentifier')
          }
          if (existing.u2a_txid !== params.u2aTxid) {
            throw new Error('Idempotency violation: receipt has different u2aTxid')
          }
          if (existing.a2u_identifier !== params.a2uIdentifier) {
            throw new Error('Idempotency violation: receipt has different a2uIdentifier')
          }
          if (existing.a2u_txid !== params.a2uTxid) {
            throw new Error('Idempotency violation: receipt has different a2uTxid')
          }
          
          if (storedCustomerAmount !== customerAmount) {
            throw new Error(`Idempotency violation: receipt has different customerAmount: ${storedCustomerAmount} vs ${customerAmount}`)
          }
          if (storedMerchantAmount !== merchantAmount) {
            throw new Error(`Idempotency violation: receipt has different merchantAmount: ${storedMerchantAmount} vs ${merchantAmount}`)
          }
          if (storedHorizonFeeCharged !== horizonFeeCharged) {
            throw new Error(`Idempotency violation: receipt has different horizonFeeCharged: ${storedHorizonFeeCharged} vs ${horizonFeeCharged}`)
          }
          if (storedAppCommission !== appCommission) {
            throw new Error(`Idempotency violation: receipt has different appCommission: ${storedAppCommission} vs ${appCommission}`)
          }
          console.log('[DB] Idempotency check passed - existing receipt matches all financial fields exactly, no duplicate credit')
        }
        
        const receiptResult = await tx`
          INSERT INTO receipts (
            transaction_id, merchant_id, merchant_uid, amount, currency, timestamp, txid,
            u2a_identifier, u2a_txid, a2u_identifier, a2u_txid, metadata, created_at,
            customer_amount, horizon_fee_charged, app_commission, merchant_amount, app_net_impact, settlement_status
          ) VALUES (${actualTransactionId}, ${params.merchantId}, ${params.merchantUid}, ${merchantAmount},
                    ${'π'}, NOW(), ${params.a2uTxid}, ${params.u2aIdentifier}, ${params.u2aTxid},
                    ${params.a2uIdentifier}, ${params.a2uTxid},
                    ${JSON.stringify({ u2aIdentifier: params.u2aIdentifier, u2aTxid: params.u2aTxid, a2uIdentifier: params.a2uIdentifier, a2uTxid: params.a2uTxid })},
                    NOW(),
                    ${customerAmount}, ${horizonFeeCharged}, ${appCommission}, ${merchantAmount}, ${appNetImpact}, ${'settled_to_merchant'})
          ON CONFLICT (transaction_id) DO NOTHING
          RETURNING id
        `

        // Only increment settled if receipt was newly inserted (RETURNING returned a row)
        // This ensures merchantAmount credit is applied EXACTLY ONCE, never duplicated on retry
        const receiptWasInserted = receiptResult && receiptResult.length > 0

        // 3. Update merchant balance - only increment if receipt is new
        // CRITICAL: Credit ONLY the actual blockchain transfer amount (merchantAmount), NOT customerAmount
        if (receiptWasInserted) {
          console.log('[DB] Crediting merchant balance:')
          console.log('[DB]   - Merchant ID:', params.merchantId)
          console.log('[DB]   - Credit amount:', merchantAmount, '(actual blockchain transfer)')
          console.log('[DB]   - App absorbs:', appNetImpact)
          
          await tx`
            INSERT INTO merchant_balances (merchant_id, settled, unsettled, last_updated)
            VALUES (${params.merchantId}, ${merchantAmount}, 0, NOW())
            ON CONFLICT (merchant_id) DO UPDATE
            SET settled = merchant_balances.settled + EXCLUDED.settled,
                last_updated = NOW()
          `
          
          console.log('[DB] ✓ Merchant balance updated with actual blockchain transfer amount')
        } else {
          console.log('[DB] Receipt was not newly inserted (idempotent retry) - skipping duplicate merchant balance credit')
        }
        
        return actualTransactionId
      })
      
      console.log('[DB] A2U transaction committed successfully:', { transactionId: result })
      
      // Select the actual committed transaction row from database to verify and return its canonical identifiers
      // This proves the transaction was actually persisted and returns evidence, not echoed params
      // Join transactions to receipts to verify both are committed and retrieve accounting identifiers
      // U2A/A2U identifiers and txids are stored in receipts table, not transactions
      const committedRowResult = await query(
        `SELECT 
           t.id, r.u2a_identifier, r.u2a_txid, r.a2u_identifier, r.a2u_txid, t.merchant_id, t.merchant_uid,
           r.customer_amount, r.horizon_fee_charged, r.app_commission, r.merchant_amount, r.app_net_impact
         FROM transactions t
         INNER JOIN receipts r ON r.transaction_id = t.id
         WHERE t.id = $1`,
        [result]
      )
      
      if (!committedRowResult || committedRowResult.length !== 1) {
        console.error('[DB] CRITICAL: Committed transaction ID not found or multiple rows returned:', result)
        return { success: false, error: 'Transaction committed but not found in database - integrity error' }
      }
      
      const committedRow = committedRowResult[0]
      
      // Type guard: validate row is non-null object with all required properties (strings and numerics)
      // Using 'in' operator checks to narrow type and typeof checks to validate values
      if (
        typeof committedRow !== 'object' ||
        committedRow === null ||
        !('u2a_identifier' in committedRow) ||
        !('u2a_txid' in committedRow) ||
        !('a2u_identifier' in committedRow) ||
        !('a2u_txid' in committedRow) ||
        !('merchant_id' in committedRow) ||
        !('merchant_uid' in committedRow) ||
        !('customer_amount' in committedRow) ||
        !('horizon_fee_charged' in committedRow) ||
        !('app_commission' in committedRow) ||
        !('merchant_amount' in committedRow) ||
        !('app_net_impact' in committedRow)
      ) {
        console.error('[DB] CRITICAL: Committed row missing required fields:', committedRow)
        return { success: false, error: 'Transaction row validation failed - required fields missing' }
      }
      
      // After in-checks above, extract and validate each property type and value
      // Use distinct names to avoid shadowing validated transaction variables
      const committedU2aIdentifier = committedRow['u2a_identifier']
      const committedU2aTxid = committedRow['u2a_txid']
      const committedA2uIdentifier = committedRow['a2u_identifier']
      const committedA2uTxid = committedRow['a2u_txid']
      const committedMerchantId = committedRow['merchant_id']
      const committedMerchantUid = committedRow['merchant_uid']
      const committedCustomerAmountRaw = committedRow['customer_amount']
      const committedHorizonFeeChargedRaw = committedRow['horizon_fee_charged']
      const committedAppCommissionRaw = committedRow['app_commission']
      const committedMerchantAmountRaw = committedRow['merchant_amount']
      const committedAppNetImpactRaw = committedRow['app_net_impact']
      
      // Validate transaction identifier strings are non-empty
      if (
        typeof committedU2aIdentifier !== 'string' || committedU2aIdentifier.trim().length === 0 ||
        typeof committedU2aTxid !== 'string' || committedU2aTxid.trim().length === 0 ||
        typeof committedA2uIdentifier !== 'string' || committedA2uIdentifier.trim().length === 0 ||
        typeof committedA2uTxid !== 'string' || committedA2uTxid.trim().length === 0 ||
        typeof committedMerchantId !== 'string' || committedMerchantId.trim().length === 0 ||
        typeof committedMerchantUid !== 'string' || committedMerchantUid.trim().length === 0
      ) {
        console.error('[DB] CRITICAL: Committed row transaction fields are not non-empty strings')
        return { success: false, error: 'Transaction row validation failed - identifier field types or values invalid' }
      }

      // Validate accounting numeric fields are valid numbers (may be 0, null, or string representations from PostgreSQL)
      const normalizedCommittedCustomerAmount = normalizePostgresNumeric(committedCustomerAmountRaw, 'committedCustomerAmount')
      const normalizedCommittedHorizonFeeCharged = normalizePostgresNumeric(committedHorizonFeeChargedRaw, 'committedHorizonFeeCharged')
      const normalizedCommittedAppCommission = normalizePostgresNumeric(committedAppCommissionRaw, 'committedAppCommission')
      const normalizedCommittedMerchantAmount = normalizePostgresNumeric(committedMerchantAmountRaw, 'committedMerchantAmount')
      const normalizedCommittedAppNetImpact = normalizePostgresNumeric(committedAppNetImpactRaw, 'committedAppNetImpact')


      // N-FIN-9: the authoritative post-COMMIT read must match the expected
      // financial identity and accounting exactly; validity of field types alone is insufficient.
      if (
        committedU2aIdentifier !== params.u2aIdentifier ||
        committedU2aTxid !== params.u2aTxid ||
        committedA2uIdentifier !== params.a2uIdentifier ||
        committedA2uTxid !== params.a2uTxid ||
        committedMerchantId !== params.merchantId ||
        committedMerchantUid !== params.merchantUid
      ) {
        console.error('[DB] CRITICAL: Committed row identity mismatch')
        return { success: false, error: 'Transaction row validation failed - committed identity mismatch' }
      }
      if (
        normalizedCommittedCustomerAmount !== customerAmount ||
        normalizedCommittedHorizonFeeCharged !== horizonFeeCharged ||
        normalizedCommittedAppCommission !== appCommission ||
        normalizedCommittedMerchantAmount !== merchantAmount ||
        normalizedCommittedAppNetImpact !== appNetImpact
      ) {
        console.error('[DB] CRITICAL: Committed row accounting mismatch')
        return { success: false, error: 'Transaction row validation failed - committed accounting mismatch' }
      }
      
      if (
        !Number.isFinite(normalizedCommittedCustomerAmount) ||
        !Number.isFinite(normalizedCommittedHorizonFeeCharged) ||
        !Number.isFinite(normalizedCommittedAppCommission) ||
        !Number.isFinite(normalizedCommittedMerchantAmount) ||
        !Number.isFinite(normalizedCommittedAppNetImpact)
      ) {
        console.error('[DB] CRITICAL: Accounting fields not finite numbers:', {
          customerAmount: normalizedCommittedCustomerAmount,
          horizonFeeCharged: normalizedCommittedHorizonFeeCharged,
          appCommission: normalizedCommittedAppCommission,
          merchantAmount: normalizedCommittedMerchantAmount,
          appNetImpact: normalizedCommittedAppNetImpact
        })
        return { success: false, error: 'Transaction row validation failed - accounting field types or values invalid' }
      }
      
      return { 
        success: true, 
        transactionId: result,
        transaction: {
          u2aIdentifier: committedU2aIdentifier,
          u2aTxid: committedU2aTxid,
          a2uIdentifier: committedA2uIdentifier,
          a2uTxid: committedA2uTxid,
          merchantId: committedMerchantId,
          merchantUid: committedMerchantUid,
        }
      }
    } finally {
      await client.end()
    }
  } catch (error) {
    console.error('[DB] A2U atomic transaction failed:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
