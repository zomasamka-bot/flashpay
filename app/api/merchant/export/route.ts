import {NextRequest,NextResponse} from "next/server"
import {createHash,randomBytes,timingSafeEqual} from "node:crypto"
import {authorizeFromHeader} from "@flashpay/financial-kernel/lib/merchant-auth"
import {redis,isRedisConfigured} from "@flashpay/financial-kernel/lib/redis"
import {readLimitedText} from "@/lib/limited-request"
import {safeExportCsv} from "@/lib/export-csv"
export const runtime="nodejs"
export const dynamic="force-dynamic"
const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"}
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers})
const prefix="flashpay:temporary-export:v1:"
export async function POST(req:NextRequest){
 const auth=await authorizeFromHeader(req.headers.get("authorization"));if(!auth)return reply({error:"UNAUTHORIZED"},401)
 if(!isRedisConfigured)return reply({error:"EXPORT_UNAVAILABLE"},503)
 if(req.headers.get("origin")&&req.headers.get("origin")!==req.nextUrl.origin)return reply({error:"ORIGIN_REJECTED"},403)
 if(req.headers.get("content-type")?.split(';')[0]!=="text/csv")return reply({error:"CSV_REQUIRED"},415)
 try{
  const csv=safeExportCsv(await readLimitedText(req,512*1024))
  const id=createHash('sha256').update(auth.uid).digest('hex'),nonce=randomBytes(32).toString('hex')
  const allowed=await redis.set(prefix+id+':cooldown','1',{nx:true,ex:3});if(!allowed)return reply({error:"EXPORT_COOLDOWN"},429)
  // One bounded file per verified account, replaced on export, automatically expires.
  await redis.set(prefix+id,JSON.stringify({nonce,csv,filename:`FLASHpay-${new Date().toISOString().slice(0,10)}.csv`}),{ex:600})
  return reply({url:`${req.nextUrl.origin}/api/merchant/export?file=${id}.${nonce}`,expiresIn:600})
 }catch(e){const invalid=e instanceof Error&&['INVALID_CSV','REQUEST_TOO_LARGE'].includes(e.message);return reply({error:invalid?'INVALID_EXPORT':'EXPORT_UNAVAILABLE'},invalid?400:503)}
}
export async function GET(req:NextRequest){
 const token=req.nextUrl.searchParams.get('file')||''
 if(!/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)||[...req.nextUrl.searchParams.keys()].join(',')!=='file')return reply({error:'EXPORT_LINK_INVALID'},404)
 try{
  const [id,nonce]=token.split('.')
  const raw=await redis.get<string|{nonce:string;csv:string;filename:string}>(prefix+id),record=typeof raw==='string'?JSON.parse(raw):raw
  if(!record||typeof record.nonce!=='string'||record.nonce.length!==64||!timingSafeEqual(Buffer.from(record.nonce),Buffer.from(nonce)))return reply({error:'EXPORT_LINK_EXPIRED'},404)
  return new NextResponse(record.csv,{headers:{...headers,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${record.filename}"`,'Content-Security-Policy':"default-src 'none'; sandbox"}})
 }catch{return reply({error:'EXPORT_UNAVAILABLE'},503)}
}
