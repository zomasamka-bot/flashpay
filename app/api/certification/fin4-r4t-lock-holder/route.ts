import {type NextRequest,NextResponse} from 'next/server'
import {fin4AuthorizeRunId} from '@/lib/fin4-live-certification'
import {holdFin4R4TWalletProbe} from '@/lib/fin4-r4t-lock-probe'
import {resolveFin4R4TSourceWallet} from '@/lib/fin4-r4t-source-wallet'
export const dynamic='force-dynamic';export const runtime='nodejs';export const maxDuration=20
export async function POST(request:NextRequest){const runId=fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'));if(!runId)return NextResponse.json({error:'Unauthorized'},{status:403});const resolved=await resolveFin4R4TSourceWallet();if(!resolved.ok)return NextResponse.json({...resolved,runId,financialMovementExecuted:false},{status:409});const out=await holdFin4R4TWalletProbe(runId,resolved.sourceWallet);return NextResponse.json({...out,paymentB:resolved.paymentB,sourceWallet:resolved.sourceWallet,sourceWalletAuthority:resolved.authority},{status:out.ok?200:409})}
