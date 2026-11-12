import {NextRequest,NextResponse} from 'next/server'
import {authorizeFromHeader} from '../../../lib/merchant-auth'
import {query} from '../../../lib/db'
export const dynamic='force-dynamic'
export const runtime='nodejs'
export async function GET(request:NextRequest){
 const id=request.nextUrl.searchParams.get('intentId')
 if(!id||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return NextResponse.json({error:'Invalid intent'},{status:400})
 const viewer=await authorizeFromHeader(request.headers.get('authorization'))
 if(!viewer)return NextResponse.json({error:'Unauthorized'},{status:401})
 try{
  const rows=await query(`SELECT i.payment_id,i.create_intent_id,i.merchant_uid,i.merchant_id,i.customer_amount::text,i.note
    FROM public.payment_create_intents i JOIN public.settlement_checkpoints s USING(payment_id)
    WHERE i.create_intent_id=$1 AND i.merchant_uid=$2 AND i.merchant_id=$3
      AND s.merchant_uid=i.merchant_uid AND s.merchant_id=i.merchant_id
      AND s.customer_amount=i.customer_amount AND s.merchant_amount+s.app_commission=i.customer_amount
    LIMIT 2`,[id,viewer.uid,viewer.username])
  if(!Array.isArray(rows))return NextResponse.json({resolution:"UNRESOLVED"},{status:503})
  if(rows.length!==1)return NextResponse.json({resolution:'UNRESOLVED'},{status:rows.length?409:404,headers:{'Cache-Control':'private, no-store'}})
  const row=rows[0] as {payment_id:string;create_intent_id:string;merchant_uid:string;merchant_id:string;customer_amount:string;note:string}
  return NextResponse.json({resolution:'FOUND',intentId:row.create_intent_id,paymentId:row.payment_id,merchantUid:row.merchant_uid,merchantId:row.merchant_id,amount:Number(row.customer_amount),note:row.note},{headers:{'Cache-Control':'private, no-store'}})
 }catch{return NextResponse.json({resolution:'UNRESOLVED'},{status:503})}
}
