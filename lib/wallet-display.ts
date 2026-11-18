import {authenticatePiWalletSession} from './pi-wallet-auth'
export type WalletDisplaySession={uid:string;accessToken:string}
export type WalletDisplayBalance={uid:string;address:string;balance:string;network:string;asOf:string}
export async function connectWalletDisplay(expectedUid:string):Promise<WalletDisplaySession>{
 const auth=await authenticatePiWalletSession(),user=auth?.user
 const uid=user?.uid||user?.userId||user?.user_id||user?.app_uid||user?.appUid
 if(uid!==expectedUid||typeof auth?.accessToken!=='string'||!auth.accessToken.trim())throw Error('AUTH_REQUIRED')
 return {uid:expectedUid,accessToken:auth.accessToken}
}
async function request(session:WalletDisplaySession,signal:AbortSignal,address?:string){
 const response=await fetch('/api/wallet/balance',{method:address===undefined?'GET':'POST',headers:{Authorization:`Bearer ${session.accessToken}`,...(address===undefined?{}:{'Content-Type':'application/json'})},body:address===undefined?undefined:JSON.stringify({address}),cache:'no-store',signal})
 const data=await response.json()
 if(!response.ok)throw Error(data.error||'WALLET_UNAVAILABLE')
 if(data.uid!==session.uid)throw Error('AUTH_REQUIRED')
 const host=data.network==='Pi Testnet'?'https://api.testnet.minepi.com':data.network==='Pi Network'?'https://api.mainnet.minepi.com':null
 if(!host||data.horizonOrigin!==host)throw Error('WALLET_UNAVAILABLE')
 return data
}
export async function readWalletDisplay(session:WalletDisplaySession,signal:AbortSignal):Promise<WalletDisplayBalance|null>{
 const data=await request(session,signal)
 if(data.address===null)return null
 if(typeof data.address!=='string'||!/^G[A-Z2-7]{55}$/.test(data.address)||typeof data.balance!=='string'||!/^\d+\.\d{1,7}$/.test(data.balance)||!Number.isFinite(Date.parse(data.asOf)))throw Error('WALLET_UNAVAILABLE')
 return data
}
export async function saveWalletDisplay(session:WalletDisplaySession,address:string,signal:AbortSignal):Promise<void>{
 const data=await request(session,signal,address)
 if(data.saved!==true||data.address!==address)throw Error('WALLET_UNAVAILABLE')
}
