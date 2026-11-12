import {StrKey} from '@stellar/stellar-sdk'
import type {FinancialNetwork} from './merchant-fee-contract'

export const NETWORK_TARGETS = Object.freeze({
  'Pi Testnet':Object.freeze({passphrase:'Pi Testnet',horizon:'https://api.testnet.minepi.com',platform:'https://api.minepi.com'}),
  'Pi Network':Object.freeze({passphrase:'Pi Network',horizon:'https://api.mainnet.minepi.com',platform:'https://api.minepi.com'}),
})
export type NetworkTransitionDraft = Readonly<{
  schema:'NETWORK_TRANSITION_DRAFT_V1'; network:FinancialNetwork; applicationId:string;
  piApplicationId:string; publicOrigin:string; incomingWallet:string; outgoingWallet:string;
  databaseIdentity:string; redisIdentity:string; trustPolicyId:string; issuerKeyId:string;
  signerKeyId:string; recoveryQueueId:string; activated:false;
}>
const fields=['schema','network','applicationId','piApplicationId','publicOrigin','incomingWallet','outgoingWallet',
  'databaseIdentity','redisIdentity','trustPolicyId','issuerKeyId','signerKeyId','recoveryQueueId','activated'].sort().join(',')
export function validateNetworkTransitionDraft(value: unknown): NetworkTransitionDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('NETWORK_DRAFT_FIELDS')
  const p = value as Record<string, unknown>
  if (Object.keys(p).sort().join(',') !== fields || p.schema !== 'NETWORK_TRANSITION_DRAFT_V1' ||
      p.activated !== false || (p.network !== 'Pi Testnet' && p.network !== 'Pi Network')) throw Error('NETWORK_DRAFT_FIELDS')
  for (const k of ['applicationId','piApplicationId','databaseIdentity','redisIdentity','trustPolicyId','issuerKeyId','signerKeyId','recoveryQueueId']) {
    if (typeof p[k] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(p[k] as string)) throw Error('NETWORK_DRAFT_IDENTITY')
  }
  if (typeof p.incomingWallet !== 'string' || typeof p.outgoingWallet !== 'string' ||
      !StrKey.isValidEd25519PublicKey(p.incomingWallet) || !StrKey.isValidEd25519PublicKey(p.outgoingWallet)) throw Error('NETWORK_DRAFT_WALLET')
  if (p.network === 'Pi Network' && p.incomingWallet === p.outgoingWallet) throw Error('NETWORK_MAINNET_WALLET_SEPARATION')
  if (p.issuerKeyId === p.signerKeyId) throw Error('NETWORK_DRAFT_KEY_SEPARATION')
  let u: URL
  try {u = new URL(String(p.publicOrigin))} catch {throw Error('NETWORK_DRAFT_ORIGIN')}
  if (u.protocol !== 'https:' || u.origin !== p.publicOrigin || u.username || u.password) throw Error('NETWORK_DRAFT_ORIGIN')
  return Object.freeze({...p}) as NetworkTransitionDraft
}
/** No resources, secrets or network state are moved by this check. */
export function assertNetworkSeparation(testnet: NetworkTransitionDraft, mainnet: NetworkTransitionDraft): void {
  const a = validateNetworkTransitionDraft(testnet), b = validateNetworkTransitionDraft(mainnet)
  if (a.network !== 'Pi Testnet' || b.network !== 'Pi Network') throw Error('NETWORK_TRANSITION_DIRECTION')
  for (const k of ['applicationId','piApplicationId','publicOrigin','databaseIdentity','redisIdentity','trustPolicyId','issuerKeyId','signerKeyId','recoveryQueueId'] as const) {
    if (a[k] === b[k]) throw Error('NETWORK_TRANSITION_SHARED_RESOURCE:'+k)
  }
  if ([a.incomingWallet,a.outgoingWallet].some(w => w === b.incomingWallet || w === b.outgoingWallet)) throw Error('NETWORK_TRANSITION_SHARED_WALLET')
  if ([a.issuerKeyId,a.signerKeyId].some(k => k === b.issuerKeyId || k === b.signerKeyId)) throw Error('NETWORK_TRANSITION_SHARED_KEY')
}
/** A draft cannot enable Mainnet. Active V1 supports Testnet/zero only. */
export {assertActiveNetworkConfiguration} from './active-financial-contract'
