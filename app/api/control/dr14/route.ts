import { NextRequest, NextResponse } from 'next/server'
import { verifyOwnerAuthorizationHeader } from '@/lib/owner-server-auth'
import { armDr14Crash, isDr14Boundary, readDr14Crash } from '@/lib/dr14-live-crash-certification'
const NO_STORE={ 'Cache-Control':'no-cache, no-store, must-revalidate' }
export async function POST(request:NextRequest){
 const auth=await verifyOwnerAuthorizationHeader(request.headers.get('authorization'))
 if(!auth.ok)return NextResponse.json({error:'Unauthorized'},{status:auth.status,headers:NO_STORE})
 const body=await request.json().catch(()=>null) as Record<string,unknown>|null
 const paymentId=typeof body?.paymentId==='string'?body.paymentId:''
 const boundary=body?.boundary
 if(body?.confirmation!=='ARM_DR14_ONE_SHOT'||!paymentId||!isDr14Boundary(boundary))return NextResponse.json({error:'Exact DR14 paymentId, boundary and confirmation required'},{status:400,headers:NO_STORE})
 const outcome=await armDr14Crash(paymentId,boundary)
 console.warn('[DR14 OWNER ARM]',{ownerUid:auth.uid,paymentId,boundary,outcome})
 return NextResponse.json({success:outcome==='ARMED',outcome,paymentId,boundary,ttlSeconds:1800,financialExecutionStarted:false},{status:outcome==='ARMED'?200:outcome==='INDETERMINATE'?503:409,headers:NO_STORE})
}
export async function GET(request:NextRequest){
 const auth=await verifyOwnerAuthorizationHeader(request.headers.get('authorization'))
 if(!auth.ok)return NextResponse.json({error:'Unauthorized'},{status:auth.status,headers:NO_STORE})
 const paymentId=request.nextUrl.searchParams.get('paymentId')??''
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId))return NextResponse.json({error:'Exact paymentId required'},{status:400,headers:NO_STORE})
 return NextResponse.json({paymentId,arm:await readDr14Crash(paymentId)},{status:200,headers:NO_STORE})
}
