import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { WalletAuthorityClaim } from './financial-wallet-authority'

export type ScopedRecoveryRight = Readonly<{
  id:string; kind:'settlement'|'refund'; op:string; wallet:string; hash:string; seq:string; stage:string; spent:boolean
}>
const active = new AsyncLocalStorage<ScopedRecoveryRight>()
export const currentRecoveryRight = () => active.getStore()
export const runWithRecoveryRight = <T>(right:ScopedRecoveryRight, run:()=>Promise<T>) => active.run(Object.freeze({...right}),run)

export function matchesRecoveryClaim(claim:WalletAuthorityClaim) {
  const right = currentRecoveryRight()
  if (!right) return process.env.FLASHPAY_RECOVERY_SCOPE !== 'admitted_new'
  return !right.spent && claim.network==='Pi Testnet' && claim.paymentId===right.id && claim.sourceWallet===right.wallet &&
    claim.operationKind===right.kind && claim.operationId===right.op && claim.preparedHash===right.hash && claim.preparedSequence===right.seq
}
