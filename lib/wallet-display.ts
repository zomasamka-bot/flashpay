// SDK addresses are presentation data only. This module never changes merchant
// identity, payment connection, financial rights or server wallet bindings.
export type WalletDisplaySession={uid:string;address:string;accessToken:string}
const isAddress=(v:unknown):v is string=>typeof v==='string'&&/^G[A-Z2-7]{55}$/.test(v)
export class WalletSelectionRequired extends Error{
 constructor(public addresses:string[]){super('WALLET_SELECTION_REQUIRED')}
}
export async function connectWalletDisplay(expectedUid:string):Promise<WalletDisplaySession>{
 if(!window.Pi||typeof window.Pi.authenticate!=='function')throw Error('WALLET_UNAVAILABLE')
 let timeout:ReturnType<typeof setTimeout>|undefined
 const auth=await Promise.race([
  window.Pi.authenticate(['username','wallet_address'],()=>{}),
  new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('WALLET_UNAVAILABLE')),60_000)})
 ]).finally(()=>clearTimeout(timeout))
 if(auth?.user?.uid!==expectedUid||typeof auth?.accessToken!=='string'||!auth.accessToken)throw Error('AUTH_REQUIRED')
 // Consent and address delivery are separate. The server resolves the user's
 // wallets when /me (and thus the SDK) omits the optional address.
 return {uid:expectedUid,address:isAddress(auth.user.wallet_address)?auth.user.wallet_address:'',accessToken:auth.accessToken}
}
export async function readWalletDisplay(session:WalletDisplaySession,signal:AbortSignal){
 const response=await fetch('/api/wallet/balance',{headers:{Authorization:`Bearer ${session.accessToken}`},cache:'no-store',signal})
 const identity=await response.json()
 if(!response.ok)throw Error(identity.error||'WALLET_UNAVAILABLE')
 if(identity.uid!==session.uid)throw Error('AUTH_REQUIRED')
 const host=identity.network==='Pi Testnet'?'https://api.testnet.minepi.com':identity.network==='Pi Network'?'https://api.mainnet.minepi.com':null
 if(!host||identity.horizonOrigin!==host)throw Error('WALLET_UNAVAILABLE')
 if(isAddress(identity.address)&&typeof identity.balance==='string'&&/^\d+\.\d{1,7}$/.test(identity.balance))return identity
 // Pi /me does not promise wallet_address. Use the consented SDK address only
 // to read public on-chain data in the browser, never as server authority.
 const addresses:string[]=Array.isArray(identity.addresses)?Array.from(new Set(identity.addresses.filter(isAddress))):[]
 let address=session.address
 if(addresses.length&&!addresses.includes(address)){
  if(addresses.length>1)throw new WalletSelectionRequired(addresses)
  address=addresses[0]
 }
 if(!isAddress(address))throw Error('WALLET_ADDRESS_UNAVAILABLE')
 const r=await fetch(`${host}/accounts/${address}`,{cache:'no-store',redirect:'error',signal})
 if(!r.ok)throw Error(r.status===404?'WALLET_NOT_ON_NETWORK':'WALLET_UNAVAILABLE')
 const account=await r.json(),balance=account.balances?.find((b:{asset_type?:string})=>b.asset_type==='native')?.balance
 if(account.account_id!==address||typeof balance!=='string'||!/^\d+\.\d{1,7}$/.test(balance))throw Error('WALLET_UNAVAILABLE')
 return {uid:identity.uid,address,balance,network:identity.network,asOf:new Date().toISOString()}
}
