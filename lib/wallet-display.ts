import { authenticatePiWalletSession } from "./pi-wallet-auth"
// SDK addresses are presentation data only. This module never changes merchant
// identity, payment connection, financial rights or server wallet bindings.
export type WalletDisplaySession={uid:string;address:string;accessToken:string;addresses?:string[]}
const isAddress=(v:unknown):v is string=>typeof v==='string'&&/^G[A-Z2-7]{55}$/.test(v)
export class WalletSelectionRequired extends Error{
 constructor(public addresses:string[]){super('WALLET_SELECTION_REQUIRED')}
}
export async function connectWalletDisplay(expectedUid:string):Promise<WalletDisplaySession>{
 const auth=await authenticatePiWalletSession()
 const user=auth?.user,uid=user?.uid||user?.userId||user?.user_id||user?.app_uid||user?.appUid
 if(uid!==expectedUid||typeof auth?.accessToken!=='string'||!auth.accessToken.trim())throw Error('AUTH_REQUIRED')
 const address=isAddress(user.wallet_address)?user.wallet_address:''
 const addresses=address?[address]:await sdkAddresses()
 if(!addresses.length)throw Error('WALLET_ADDRESS_UNAVAILABLE')
 return {uid:expectedUid,address,accessToken:auth.accessToken,addresses}
}
async function sdkAddresses():Promise<string[]>{
 const wallet=window.Pi?.Wallet
 if(typeof wallet?.getUserWalletAddresses!=='function')throw Error('WALLET_SDK_UNAVAILABLE')
 try{
  const result=await wallet.getUserWalletAddresses()
  return Array.from(new Set((result?.wallets||[]).map(w=>w.publicKey).filter(isAddress)))
 }catch(e){
  const message=e instanceof Error?e.message:''
  const code=/Unauthorized app/i.test(message)?'WALLET_APP_UNAUTHORIZED':/wallet_address scope/i.test(message)?'WALLET_PERMISSION_REQUIRED':/not authenticated|authenticate first|must be authenticated/i.test(message)?'AUTH_REQUIRED':'WALLET_ADDRESS_UNAVAILABLE'
  console.warn('[Wallet display]',{stage:'sdk_address',code})
  throw Error(code)
 }
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
 if(!session.addresses)throw Error('AUTH_REQUIRED')
 const addresses=session.addresses
 if(signal.aborted)throw Error('WALLET_UNAVAILABLE')
 let address=session.address
 if(addresses.length&&!addresses.includes(address)){
  if(addresses.length>1)throw new WalletSelectionRequired(addresses)
  address=addresses[0]
 }
 if(!addresses.includes(address)||!isAddress(address))throw Error('WALLET_ADDRESS_UNAVAILABLE')
 const r=await fetch(`${host}/accounts/${address}`,{cache:'no-store',redirect:'error',signal})
 if(!r.ok)throw Error(r.status===404?'WALLET_NOT_ON_NETWORK':'WALLET_UNAVAILABLE')
 const account=await r.json(),balance=account.balances?.find((b:{asset_type?:string})=>b.asset_type==='native')?.balance
 if(account.account_id!==address||typeof balance!=='string'||!/^\d+\.\d{1,7}$/.test(balance))throw Error('WALLET_UNAVAILABLE')
 return {uid:identity.uid,address,balance,network:identity.network,asOf:new Date().toISOString()}
}
