import {NextRequest,NextResponse} from "next/server"
import {financialNetwork,financialHorizonOrigin} from "@flashpay/financial-kernel/lib/financial-network"
export const dynamic="force-dynamic"
export const runtime="nodejs"
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"private, no-store"}})
// Read-only verified identity. SDK wallet fallback stays on the client for presentation only; never accept a client-supplied financial address.
export async function GET(req:NextRequest){
 const auth=req.headers.get("authorization")
 if(!auth?.startsWith("Bearer ")||auth.length>4096)return reply({error:"AUTH_REQUIRED"},401)
 if(new URL(req.url).search)return reply({error:"INVALID_SCOPE"},400)
 try{
  const me=await fetch("https://api.minepi.com/v2/me",{headers:{Authorization:auth},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(8000)})
  if(!me.ok)return reply({error:me.status===401||me.status===403?"AUTH_REQUIRED":"WALLET_UNAVAILABLE"},me.status===401||me.status===403?401:503)
  const identity=await me.json()
  if(typeof identity.uid!=="string"||!identity.uid)return reply({error:"AUTH_REQUIRED"},401)
  const address=identity.wallet_address
  if(typeof address!=="string"||!/^G[A-Z2-7]{55}$/.test(address))return reply({uid:identity.uid,address:null,network:financialNetwork(),horizonOrigin:financialHorizonOrigin()})
  const response=await fetch(`${financialHorizonOrigin()}/accounts/${address}`,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(8000)})
  // An unfunded or unavailable account is not silently presented as zero.
  if(!response.ok)return reply({error:response.status===404?"WALLET_NOT_ON_NETWORK":"WALLET_UNAVAILABLE",network:financialNetwork()},response.status===404?409:503)
  const account=await response.json()
  const balance=account.balances?.find((b:{asset_type?:string})=>b.asset_type==="native")?.balance
  if(account.account_id!==address||typeof balance!=="string"||!/^\d+\.\d{1,7}$/.test(balance))return reply({error:"WALLET_UNAVAILABLE"},503)
  return reply({uid:identity.uid,address,balance,network:financialNetwork(),asOf:new Date().toISOString()})
 }catch{return reply({error:"WALLET_UNAVAILABLE"},503)}
}
