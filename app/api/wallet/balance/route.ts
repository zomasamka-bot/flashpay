import {NextRequest,NextResponse} from 'next/server'
import {StrKey} from '@stellar/stellar-sdk'
import {deployment} from '@flashpay/financial-kernel/deployment'
import {financialNetwork,financialHorizonOrigin} from '@flashpay/financial-kernel/lib/financial-network'
import {savedWalletAddress,saveWalletAddressOnce} from '@/lib/wallet-display-store'
export const dynamic='force-dynamic'
export const runtime='nodejs'
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}})
class WalletError extends Error{constructor(message:string,public status:number){super(message)}}
async function identity(req:NextRequest){
 const auth=req.headers.get('authorization')
 if(!auth?.startsWith('Bearer ')||auth.length>4096)throw new WalletError('AUTH_REQUIRED',401)
 if(new URL(req.url).search)throw new WalletError('INVALID_SCOPE',400)
 const me=await fetch('https://api.minepi.com/v2/me',{headers:{Authorization:auth},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})
 if(!me.ok)throw new WalletError(me.status===401||me.status===403?'AUTH_REQUIRED':'WALLET_UNAVAILABLE',me.status===401||me.status===403?401:503)
 const user=await me.json()
 if(typeof user.uid!=='string'||!user.uid||user.uid.length>256)throw new WalletError('AUTH_REQUIRED',401)
 return user.uid as string
}
async function balance(address:string){
 if(!StrKey.isValidEd25519PublicKey(address))throw new WalletError('WALLET_UNAVAILABLE',503)
 const response=await fetch(`${financialHorizonOrigin()}/accounts/${address}`,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})
 if(!response.ok)throw new WalletError(response.status===404?'WALLET_NOT_ON_NETWORK':'WALLET_UNAVAILABLE',response.status===404?409:503)
 const account=await response.json(),amount=account.balances?.find((b:{asset_type?:string})=>b.asset_type==='native')?.balance
 if(account.account_id!==address||typeof amount!=='string'||!/^\d+\.\d{1,7}$/.test(amount))throw new WalletError('WALLET_UNAVAILABLE',503)
 return amount
}
const network=()=>({network:financialNetwork(),horizonOrigin:financialHorizonOrigin()})
const failure=(e:unknown)=>e instanceof WalletError?reply({error:e.message},e.status):reply({error:'WALLET_UNAVAILABLE'},503)
export async function GET(req:NextRequest){
 try{
  const uid=await identity(req),scope=network(),address=await savedWalletAddress(uid,scope.network)
  if(!address)return reply({uid,address:null,...scope})
  return reply({uid,address,balance:await balance(address),...scope,asOf:new Date().toISOString()})
 }catch(e){return failure(e)}
}
export async function POST(req:NextRequest){
 try{
  const uid=await identity(req)
  if(req.headers.get('origin')!==deployment().publicOrigin)throw new WalletError('INVALID_SCOPE',403)
  if(!req.headers.get('content-type')?.startsWith('application/json'))throw new WalletError('INVALID_ADDRESS',400)
  const raw=await req.text()
  if(raw.length>256)throw new WalletError('INVALID_ADDRESS',400)
  let input:unknown;try{input=JSON.parse(raw)}catch{throw new WalletError('INVALID_ADDRESS',400)}
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!=='address')throw new WalletError('INVALID_ADDRESS',400)
  const address=(input as {address:unknown}).address
  if(typeof address!=='string'||!StrKey.isValidEd25519PublicKey(address))throw new WalletError('INVALID_ADDRESS',400)
  const scope=network(),existing=await savedWalletAddress(uid,scope.network)
  if(existing&&existing!==address)throw new WalletError('WALLET_ALREADY_SAVED',409)
  if(!existing){
   // Validate the configured network before the first durable write.
   await balance(address)
   if(await saveWalletAddressOnce(uid,scope.network,address)!==address)throw new WalletError('WALLET_ALREADY_SAVED',409)
  }
  return reply({uid,address,...scope,saved:true})
 }catch(e){return failure(e)}
}
