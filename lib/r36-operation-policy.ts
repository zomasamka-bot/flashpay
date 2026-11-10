/** Operating limits are enrolled policy, not a client flag or an authority grant. */
export const MAX_APPLICATION_STROOPS = BigInt('10000000000000') // Existing 1,000,000 Pi input ceiling.
type ObjectValue=Record<string,unknown>
const obj=(v:unknown):v is ObjectValue=>!!v&&typeof v==='object'&&!Array.isArray(v)
export function generalOperationPolicy(profile:unknown):{sourceWallet:string;maxAmountStroops:bigint}|null {
 if(!obj(profile)||'recoveryPilot' in profile||!obj(profile.generalOperation))return null
 const p=profile.generalOperation
 if(p.schema!=='R36_GENERAL_TESTNET_V1'||p.network!=='Pi Testnet'||p.identitySource!=='PI_V2_ME'||
 p.allowTerminalReservationTurnover!==true||typeof p.sourceWallet!=='string'||!/^G[A-Z2-7]{55}$/.test(p.sourceWallet)||
 typeof p.maxAmountStroops!=='string'||! /^[1-9][0-9]{0,13}$/.test(p.maxAmountStroops))return null
 const max=BigInt(p.maxAmountStroops)
 return max<=MAX_APPLICATION_STROOPS?{sourceWallet:p.sourceWallet,maxAmountStroops:max}:null
}
export function originalRefundCertificationEnabled(network:unknown,amount:unknown):boolean {
 return process.env.FLASHPAY_ENABLE_EXACT_REFUND_CERTIFICATION==='true' && network==='Pi Testnet' && amount===0.1
}
