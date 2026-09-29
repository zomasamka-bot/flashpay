export interface Dr17SharedCertificationReport {
  certification: 'PASS'
  gate: 'DR17-SHARED-RESOURCE-SAFE-10K-PERSISTENCE-CONCURRENCY'
  runId: string
  total: number
  settlements: number
  refunds: number
  distinctIds: number
  badMovementCount: number
  settlementRefundOverlap: number
  lostRecovery: number
  redisReadyAfterCrash: number
  redisRecovered: number
  workers: number
  durationMs: number
  maxObservedOperationMs: number
  sharedDatabaseResource: true
  sharedRedisResource: true
  productionFinancialTablesTargeted: false
  productionRuntimeRedisKeysTargeted: false
  piCalled: false
  horizonCalled: false
}

export function runDr17SharedResourceSafe10k(): Promise<Dr17SharedCertificationReport>
