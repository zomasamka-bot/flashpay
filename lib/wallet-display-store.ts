import 'server-only'
import postgres from 'postgres'
import {deployment,verifyDatabaseUrl,verifyDatabaseBinding} from '@flashpay/financial-kernel/deployment'

// Presentation preference only. Never read this table as payment authority.
let client:ReturnType<typeof postgres>|undefined
let opening:Promise<ReturnType<typeof postgres>>|undefined
async function database(){
 if(client)return client
 if(opening)return opening
 opening=(async()=>{
  const url=process.env.DATABASE_URL
  if(!url)throw Error('WALLET_UNAVAILABLE')
  verifyDatabaseUrl(url)
  const db=postgres(url,{ssl:{rejectUnauthorized:true},max:2,idle_timeout:20,connect_timeout:8,connection:{statement_timeout:8000}})
  try{await verifyDatabaseBinding(db as any);client=db;return db}catch(e){await db.end({timeout:1});throw e}
 })()
 try{return await opening}finally{opening=undefined}
}
export async function savedWalletAddress(uid:string,network:string):Promise<string|null>{
 const db=await database()
 const rows=await db`SELECT address FROM public.wallet_display_preferences WHERE application_id=${deployment().applicationId} AND pi_uid=${uid} AND network=${network}`
 return rows[0]?.address??null
}
export async function saveWalletAddressOnce(uid:string,network:string,address:string):Promise<string>{
 const db=await database()
 await db`INSERT INTO public.wallet_display_preferences (application_id,pi_uid,network,address) VALUES (${deployment().applicationId},${uid},${network},${address}) ON CONFLICT (application_id,pi_uid,network) DO NOTHING`
 // Separate statement sees the winning committed insert after a concurrent save.
 const stored=await savedWalletAddress(uid,network)
 if(!stored)throw Error('WALLET_UNAVAILABLE')
 return stored
}
