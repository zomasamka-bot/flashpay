import { NextRequest, NextResponse } from 'next/server'
import { verifyOwnerAuthorizationHeader } from '@/lib/owner-server-auth'
import { armDr14Crash, isDr14Boundary, readDr14Crash, readDr14Readiness } from '@/lib/dr14-live-crash-certification'
import { executeRefundNextStep } from '@/lib/refund-executor'
import { query } from '@/lib/db'
const NO_STORE={ 'Cache-Control':'no-cache, no-store, must-revalidate' }
export async function POST(request:NextRequest){
 const auth=await verifyOwnerAuthorizationHeader(request.headers.get('authorization'))
 if(!auth.ok)return NextResponse.json({error:'Unauthorized'},{status:auth.status,headers:NO_STORE})
 const body=await request.json().catch(()=>null) as Record<string,unknown>|null
 const paymentId=typeof body?.paymentId==='string'?body.paymentId:''
 const boundary=body?.boundary
 if(!paymentId||!isDr14Boundary(boundary)||(body?.confirmation!=='READINESS_DR14_ONLY'&&body?.confirmation!=='ARM_DR14_ONE_SHOT'&&body?.confirmation!=='START_DR14_REFUND_ONCE'))return NextResponse.json({error:'Exact DR14 paymentId, boundary and confirmation required'},{status:400,headers:NO_STORE})
 const readiness=await readDr14Readiness(paymentId,boundary)
 if(body.confirmation==='START_DR14_REFUND_ONCE'){
  if(boundary!=='refund_after_pi_create_before_id_checkpoint'||readiness.outcome!=='CONFLICT'){
   const arm=await readDr14Crash(paymentId)
   if(!arm||arm.boundary!==boundary||arm.consumedAt!==null||Date.parse(arm.expiresAt)<=Date.now())return NextResponse.json({success:false,outcome:'NOT_ARMED',financialExecutionStarted:false},{status:409,headers:NO_STORE})
  }
  const arm=await readDr14Crash(paymentId)
  if(!arm||arm.boundary!==boundary||arm.consumedAt!==null||Date.parse(arm.expiresAt)<=Date.now())return NextResponse.json({success:false,outcome:'NOT_ARMED',financialExecutionStarted:false},{status:409,headers:NO_STORE})
  const rows=await query(`UPDATE refund_checkpoints SET last_error_code=NULL,last_error_message=NULL,next_retry_at=NULL,updated_at=NOW() WHERE payment_id=$1 AND status='pending' AND stage='intent_created' AND refund_payment_id IS NULL AND refund_txid IS NULL AND last_error_code='dr11_live_hold' AND last_error_message='awaiting_owner_concurrent_harness' AND next_retry_at>NOW() RETURNING refund_id,payment_id`,[paymentId])
  if(!Array.isArray(rows)||rows.length!==1)return NextResponse.json({success:false,outcome:'HOLD_RELEASE_CONFLICT',financialExecutionStarted:false},{status:409,headers:NO_STORE})
  const refundId=String((rows[0] as Record<string,unknown>).refund_id??'')
  const execution=await executeRefundNextStep(refundId,{paymentId,refundId})
  console.warn('[DR85 DR14 REFUND START]',{ownerUid:auth.uid,paymentId,refundId,boundary,outcome:execution.outcome})
  return NextResponse.json({success:true,outcome:'STARTED',paymentId,refundId,boundary,execution,financialExecutionStarted:true},{status:200,headers:NO_STORE})
 }
 if(body.confirmation==='READINESS_DR14_ONLY')return NextResponse.json({success:readiness.outcome==='READY',mode:'readiness',readiness,financialExecutionStarted:false},{status:readiness.outcome==='READY'?200:readiness.outcome==='INDETERMINATE'?503:409,headers:NO_STORE})
 if(readiness.outcome!=='READY')return NextResponse.json({success:false,outcome:readiness.outcome,readiness,financialExecutionStarted:false},{status:readiness.outcome==='INDETERMINATE'?503:409,headers:NO_STORE})
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
