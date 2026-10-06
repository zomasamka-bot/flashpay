import {type NextRequest,NextResponse} from 'next/server'
import {fin4AuthorizeRunId} from '@/lib/fin4-live-certification'
import {readFin4R4T61ReverseHorizonScan} from '@/lib/fin4-r4t61-reverse-horizon-scan'
export const dynamic='force-dynamic';export const runtime='nodejs'
export async function GET(request:NextRequest){
 const runId=fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'))
 if(!runId)return NextResponse.json({error:'Unauthorized'},{status:403})
 const scan=await readFin4R4T61ReverseHorizonScan()
 return NextResponse.json({...scan,runId},{status:scan.ok?200:503})
}
