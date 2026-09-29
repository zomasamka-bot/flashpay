export interface Dr17CapacityObservation {
  referenceMs: number
  observedMs: number
  exceededReference: boolean
  excessMs: number
  updateP50Ms: number
  updateP95Ms: number
  updateP99Ms: number
  updateMaxMs: number
  samples: number
  workers: number
}
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
  capacityObservation: Dr17CapacityObservation
  forensic: Record<string, unknown> | null
  sharedDatabaseResource: true
  sharedRedisResource: true
  productionFinancialTablesTargeted: false
  productionRuntimeRedisKeysTargeted: false
  piCalled: false
  horizonCalled: false
}
export interface Dr17SharedCertificationOptions { trustedProductionExecution?: boolean }
export function runDr17SharedResourceSafe10k(options?: Dr17SharedCertificationOptions): Promise<Dr17SharedCertificationReport>
