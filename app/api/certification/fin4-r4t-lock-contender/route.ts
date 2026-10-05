import { type NextRequest,NextResponse } from 'next/server'
import { fin4AuthorizeRunId } from '@/lib/fin4-live-certification'
import { contendFin4R4TWalletProbe } from '@/lib/fin4-r4t-lock-probe'
export const dynamic='force-dynamic'; export const runtime='nodejs'; export const maxDuration=20
export async function POST(r:NextRequest){const runId=fin4AuthorizeRunId(r.headers.get('x-flashpay-fin4-run-id'));if(!runId)return NextResponse.json({error:'Unauthorized'},{status:403});const wallet=process.env.FLASHPAY_PI_PUBLIC_KEY?.trim()??'';return NextResponse.json(await contendFin4R4TWalletProbe(runId,wallet))}
