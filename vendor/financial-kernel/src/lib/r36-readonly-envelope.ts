/** Bounded memoization of deterministic SDK decoding ONLY. The complete XDR
 * and network are the key. No Horizon observation, finality, financial verdict,
 * policy, revocation, balance, or signing authority is cached here. Callers still
 * compare every current record and apply all original accounting/identity gates.
 * Only frozen primitive facts escape; no mutable SDK transaction is shared. */
import {Asset,Transaction,TransactionBuilder} from '@stellar/stellar-sdk'
type OperationFact=Readonly<{type:string;source:string|undefined;destination:string;amount:string;startingBalance:string;nativeAsset:boolean;assetIsSdk:boolean}>
export type R36ReadonlyEnvelope=Readonly<{isTransaction:boolean;canonical:string;hash:string;source:string;sequence:string;fee:string;operations:readonly OperationFact[]}>
const cache=new Map<string,{value:R36ReadonlyEnvelope;bytes:number}>()
let bytes=0
const MAX_BYTES=48_000_000,MAX_ENTRIES=40002
export function readR36ReadonlyEnvelope(encoded:string,network:string):R36ReadonlyEnvelope{
 const key=network+'\n'+encoded,hit=cache.get(key);if(hit)return hit.value
 const parsed=TransactionBuilder.fromXDR(encoded,network),isTransaction=parsed instanceof Transaction
 const operations=isTransaction?parsed.operations.map(op=>{
  const payment=op.type==='payment',creation=op.type==='createAccount'
  return Object.freeze({type:op.type,source:op.source,destination:payment||creation?op.destination:'',amount:payment?op.amount:'',startingBalance:creation?op.startingBalance:'',nativeAsset:payment&&op.asset instanceof Asset&&op.asset.isNative(),assetIsSdk:payment&&op.asset instanceof Asset})
 }):[]
 const value=Object.freeze({isTransaction,canonical:parsed.toXDR(),hash:Buffer.from(parsed.hash()).toString('hex'),source:isTransaction?parsed.source:'',sequence:isTransaction?parsed.sequence:'',fee:parsed.fee,operations:Object.freeze(operations)})
 // Keep large or exceptional envelopes on the original uncached decode path.
 const size=2*(key.length+JSON.stringify(value).length)
 if(encoded.length<=65536&&size<=MAX_BYTES){while(cache.size&&(cache.size>=MAX_ENTRIES||bytes+size>MAX_BYTES)){const first=cache.keys().next().value!;bytes-=cache.get(first)!.bytes;cache.delete(first)}cache.set(key,{value,bytes:size});bytes+=size}
 return value
}
