import {NextRequest,NextResponse,after} from 'next/server'
import {verifyOwnerAuthorizationHeader} from '@flashpay/financial-kernel/lib/owner-server-auth'
import {wakePrivateArchive} from '@flashpay/financial-kernel/lib/r36-private-archive-wake'
import {storageStatus,privateStorage,issueCleanupTicket,verifyCleanupTicket,invalidateStorageStatus} from '@/lib/storage-control-server'
export const runtime='nodejs'
export const dynamic='force-dynamic'
const response=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}})
export async function GET(req:NextRequest){
 const auth=await verifyOwnerAuthorizationHeader(req.headers.get('authorization'));if(!auth.ok)return response({error:'UNAUTHORIZED'},auth.status)
 try{return response(await storageStatus())}catch{return response({error:'STORAGE_UNAVAILABLE',asOf:new Date().toISOString()},503)}
}
export async function POST(req:NextRequest){
 const auth=await verifyOwnerAuthorizationHeader(req.headers.get('authorization'));if(!auth.ok)return response({error:'UNAUTHORIZED'},auth.status)
 const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return response({error:'ORIGIN_REJECTED'},403)
 try{
  const raw=await req.text();if(raw.length>1200)return response({error:'REQUEST_SCOPE'},400)
  const body=JSON.parse(raw)
  if(body?.action==='preview'&&Object.keys(body).join(',')==='action'){
   const value=await privateStorage('preview');return response({preview:value.preview,ticket:issueCleanupTicket(auth.uid,value.preview.digest),asOf:value.asOf,financialAuthority:false})
  }
  if(body?.action==='execute'&&Object.keys(body).sort().join(',')==='action,ticket'&&verifyCleanupTicket(auth.uid,body.ticket)){
   const value=await privateStorage('enqueue',{id:body.ticket.id,digest:body.ticket.digest});invalidateStorageStatus()
   if(value.status==='queued')after(wakePrivateArchive)
   return response(value,value.status==='cooldown'?429:202)
  }
  return response({error:'REQUEST_SCOPE'},400)
 }catch(e){if(e instanceof SyntaxError)return response({error:'REQUEST_INVALID'},400);const changed=e instanceof Error&&e.message==='PREVIEW_CHANGED';return response({error:changed?'PREVIEW_CHANGED':'STORAGE_UNAVAILABLE'},changed?409:503)}
}
