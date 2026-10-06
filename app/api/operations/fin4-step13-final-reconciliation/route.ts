import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { serverConfig } from "@/lib/server-config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const RUN_ID = "FIN4-20261005-1643-D50D"
const A = { paymentId:"d50d0a46-a305-4008-9843-e50b8d3c265c", piPaymentId:"8iQhX3K7cVFLl7zadFfO6DEjB4u6", amount:1.7 }
const B = { paymentId:"870a49eb-f0ce-42b8-8682-e334ded12b84", piPaymentId:"zFxWLWJC16kTiuqTyMLMqcQ1NRAL", amount:1.4, a2uPaymentId:"SA5oKLuhfnQuU6x2PVm6PkQd4kCc", txid:"91b09b990184fa73bd8c893a2b514a1d4576be42ae933140511df25b9e682c87" }
const C = { paymentId:"a0553edf-8784-4758-a246-2da36847a3b8", piPaymentId:"JYJ36kpTyzUPuEFd0uJIWAynLCJK", amount:1.2 }

type Row = Record<string,unknown>
function one(v:unknown):Row|null { return Array.isArray(v)&&v.length===1&&v[0]&&typeof v[0]==="object"&&!Array.isArray(v[0]) ? v[0] as Row : null }
function many(v:unknown):Row[]|null { return Array.isArray(v)&&v.every(x=>x&&typeof x==="object"&&!Array.isArray(x)) ? v as Row[] : null }
function n(v:unknown):number { const x=Number(v); return Number.isFinite(x)?x:Number.NaN }
function s(v:unknown):string|null { return typeof v==="string"&&v.trim()?v.trim():null }
function bool(v:unknown):boolean { return v===true }

async function piGet(id:string):Promise<{ok:true,payment:any}|{ok:false,error:string}> {
  if(!serverConfig.isPiApiKeyConfigured) return {ok:false,error:"PI_API_KEY_UNAVAILABLE"}
  try {
    const r=await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(id)}`,{headers:{Authorization:`Key ${serverConfig.piApiKey}`},cache:"no-store"})
    if(!r.ok)return{ok:false,error:`PI_HTTP_${r.status}`}
    const payment=await r.json().catch(()=>null); if(!payment||typeof payment!=="object")return{ok:false,error:"PI_BODY_INVALID"}
    return{ok:true,payment}
  } catch { return{ok:false,error:"PI_READ_FAILED"} }
}

async function horizonTx(hash:string):Promise<{ok:true,tx:any,ops:any[]}|{ok:false,error:string}> {
  try {
    const tr=await fetch(`https://api.testnet.minepi.com/transactions/${encodeURIComponent(hash)}`,{cache:"no-store"})
    if(!tr.ok)return{ok:false,error:`HORIZON_TX_HTTP_${tr.status}`}
    const tx=await tr.json().catch(()=>null); if(!tx||typeof tx!=="object")return{ok:false,error:"HORIZON_TX_INVALID"}
    const or=await fetch(`https://api.testnet.minepi.com/transactions/${encodeURIComponent(hash)}/operations?limit=20`,{cache:"no-store"})
    if(!or.ok)return{ok:false,error:`HORIZON_OPS_HTTP_${or.status}`}
    const ob=await or.json().catch(()=>null); const ops=ob?._embedded?.records
    if(!Array.isArray(ops))return{ok:false,error:"HORIZON_OPS_INVALID"}
    return{ok:true,tx,ops}
  } catch { return{ok:false,error:"HORIZON_READ_FAILED"} }
}

function piU2AExact(p:any,x:{paymentId:string,piPaymentId:string,amount:number}, completed:boolean, cancelled:boolean) {
  return p?.identifier===x.piPaymentId && p?.metadata?.paymentId===x.paymentId && p?.network==="Pi Testnet" && p?.direction==="user_to_app" && n(p?.amount)===x.amount &&
    bool(p?.status?.developer_approved) && bool(p?.status?.transaction_verified)===completed && bool(p?.status?.developer_completed)===completed &&
    (bool(p?.status?.cancelled)||bool(p?.status?.user_cancelled))===cancelled && (completed ? !!s(p?.transaction?.txid) : p?.transaction==null)
}

export async function GET(request:NextRequest) {
  const runId=new URL(request.url).searchParams.get("runId")
  if(runId!==RUN_ID)return NextResponse.json({ok:false,verdict:"RUN_ID_REJECTED",readOnly:true},{status:404,headers:{"Cache-Control":"no-store"}})
  if(!process.env.DATABASE_URL)return NextResponse.json({ok:false,verdict:"INDETERMINATE",reason:"DATABASE_UNAVAILABLE",readOnly:true},{status:503,headers:{"Cache-Control":"no-store"}})

  try {
    const ids=[A.paymentId,B.paymentId,C.paymentId]
    const [settlementsRaw,refundsRaw,refundRetRaw,u2aRetRaw,txRaw,receiptsRaw,refundAcctRaw,dupsRaw,refundDupsRaw,balanceRaw,xorRaw,totalsRaw,piA,piB,piC,piBA2U,hB] = await Promise.all([
      query(`SELECT payment_id,stage,merchant_id,merchant_uid,customer_amount,merchant_amount,app_commission,u2a_identifier,u2a_txid,a2u_payment_id,a2u_from_address,a2u_to_address,prepared_tx_hash,prepared_sequence,a2u_txid,horizon_fee_stroops,horizon_confirmed_at,pi_completed_at,db_finalized_at FROM settlement_checkpoints WHERE payment_id = ANY($1::text[]) ORDER BY payment_id`,[ids]),
      query(`SELECT refund_id,payment_id,status,stage,amount,refund_payment_id,refund_txid FROM refund_checkpoints WHERE payment_id = ANY($1::text[]) ORDER BY payment_id`,[ids]),
      query(`SELECT refund_id,payment_id,reason,evidence_code,created_at FROM refund_automatic_retirements WHERE payment_id = ANY($1::text[]) ORDER BY payment_id`,[ids]),
      query(`SELECT payment_id,pi_payment_id,reason,pi_cancelled_at,retired_at FROM settlement_u2a_approval_retirements WHERE payment_id = ANY($1::text[]) ORDER BY payment_id`,[ids]),
      query(`SELECT id,payment_id,merchant_id,merchant_uid,amount,status FROM transactions WHERE payment_id = ANY($1::text[]) ORDER BY payment_id`,[ids]),
      query(`SELECT r.transaction_id,t.payment_id,r.merchant_id,r.merchant_uid,r.customer_amount,r.merchant_amount,r.app_commission,r.horizon_fee_charged,r.app_net_impact,r.settlement_status,r.u2a_identifier,r.u2a_txid,r.a2u_identifier,r.a2u_txid FROM receipts r JOIN transactions t ON t.id=r.transaction_id WHERE t.payment_id = ANY($1::text[]) ORDER BY t.payment_id`,[ids]),
      query(`SELECT refund_id,payment_id,refund_payment_id,refund_txid,amount,horizon_fee_stroops FROM refund_accounting_records WHERE payment_id = ANY($1::text[]) ORDER BY payment_id`,[ids]),
      query(`SELECT identity,value,duplicate_count FROM (SELECT 'transactions.payment_id' identity,payment_id value,COUNT(*)::bigint duplicate_count FROM transactions GROUP BY payment_id HAVING COUNT(*)>1 UNION ALL SELECT 'receipts.u2a_identifier',u2a_identifier,COUNT(*)::bigint FROM receipts WHERE u2a_identifier IS NOT NULL GROUP BY u2a_identifier HAVING COUNT(*)>1 UNION ALL SELECT 'receipts.u2a_txid',u2a_txid,COUNT(*)::bigint FROM receipts WHERE u2a_txid IS NOT NULL GROUP BY u2a_txid HAVING COUNT(*)>1 UNION ALL SELECT 'receipts.a2u_identifier',a2u_identifier,COUNT(*)::bigint FROM receipts WHERE a2u_identifier IS NOT NULL GROUP BY a2u_identifier HAVING COUNT(*)>1 UNION ALL SELECT 'receipts.a2u_txid',a2u_txid,COUNT(*)::bigint FROM receipts WHERE a2u_txid IS NOT NULL GROUP BY a2u_txid HAVING COUNT(*)>1 UNION ALL SELECT 'settlement_checkpoints.prepared_tx_hash',prepared_tx_hash,COUNT(*)::bigint FROM settlement_checkpoints WHERE prepared_tx_hash IS NOT NULL GROUP BY prepared_tx_hash HAVING COUNT(*)>1 UNION ALL SELECT 'settlement_checkpoints.a2u_txid',a2u_txid,COUNT(*)::bigint FROM settlement_checkpoints WHERE a2u_txid IS NOT NULL GROUP BY a2u_txid HAVING COUNT(*)>1) d ORDER BY identity,value`),
      query(`SELECT identity,value,duplicate_count FROM (SELECT 'refund_accounting_records.payment_id' identity,payment_id value,COUNT(*)::bigint duplicate_count FROM refund_accounting_records GROUP BY payment_id HAVING COUNT(*)>1 UNION ALL SELECT 'refund_accounting_records.refund_txid',refund_txid,COUNT(*)::bigint FROM refund_accounting_records GROUP BY refund_txid HAVING COUNT(*)>1 UNION ALL SELECT 'refund_checkpoints.payment_id',payment_id,COUNT(*)::bigint FROM refund_checkpoints GROUP BY payment_id HAVING COUNT(*)>1) d ORDER BY identity,value`),
      query(`WITH canonical AS (SELECT merchant_id,COALESCE(SUM(merchant_amount),0) canonical_settled FROM receipts WHERE settlement_status='settled_to_merchant' GROUP BY merchant_id), all_m AS (SELECT merchant_id FROM merchant_balances UNION SELECT merchant_id FROM canonical) SELECT m.merchant_id,COALESCE(b.settled,0) stored_settled,COALESCE(c.canonical_settled,0) canonical_settled,COALESCE(b.unsettled,0) stored_unsettled FROM all_m m LEFT JOIN merchant_balances b USING(merchant_id) LEFT JOIN canonical c USING(merchant_id) WHERE COALESCE(b.settled,0)<>COALESCE(c.canonical_settled,0) OR COALESCE(b.unsettled,0)<>0 ORDER BY m.merchant_id`),
      query(`SELECT s.payment_id,s.a2u_txid,r.refund_txid FROM settlement_checkpoints s JOIN refund_accounting_records r USING(payment_id) WHERE s.a2u_txid IS NOT NULL AND r.refund_txid IS NOT NULL ORDER BY s.payment_id`),
      query(`SELECT (SELECT COUNT(*) FROM transactions)::bigint transactions,(SELECT COUNT(*) FROM receipts)::bigint receipts,(SELECT COUNT(*) FROM settlement_checkpoints)::bigint settlement_checkpoints,(SELECT COUNT(*) FROM refund_checkpoints)::bigint refund_checkpoints,(SELECT COUNT(*) FROM refund_accounting_records)::bigint refund_accounting_records`),
      piGet(A.piPaymentId),piGet(B.piPaymentId),piGet(C.piPaymentId),piGet(B.a2uPaymentId),horizonTx(B.txid)
    ])

    const settlements=many(settlementsRaw), refunds=many(refundsRaw), refundRet=many(refundRetRaw), u2aRet=many(u2aRetRaw), txs=many(txRaw), receipts=many(receiptsRaw), refundAcct=many(refundAcctRaw), dups=many(dupsRaw), refundDups=many(refundDupsRaw), balances=many(balanceRaw), xor=many(xorRaw), totals=one(totalsRaw)
    if(!settlements||!refunds||!refundRet||!u2aRet||!txs||!receipts||!refundAcct||!dups||!refundDups||!balances||!xor||!totals||!piA.ok||!piB.ok||!piC.ok||!piBA2U.ok||!hB.ok)
      return NextResponse.json({ok:false,verdict:"INDETERMINATE",readOnly:true,sources:{db:!!(settlements&&refunds&&refundRet&&u2aRet&&txs&&receipts&&refundAcct&&dups&&refundDups&&balances&&xor&&totals),pi:{A:piA.ok,B:piB.ok,C:piC.ok,BA2U:piBA2U.ok},horizon:hB.ok},financialMutationExecuted:false},{status:503,headers:{"Cache-Control":"no-store"}})

    const ss=(id:string)=>settlements.filter(r=>r.payment_id===id), rf=(id:string)=>refunds.filter(r=>r.payment_id===id), rr=(id:string)=>refundRet.filter(r=>r.payment_id===id), ur=(id:string)=>u2aRet.filter(r=>r.payment_id===id), tt=(id:string)=>txs.filter(r=>r.payment_id===id), rc=(id:string)=>receipts.filter(r=>r.payment_id===id), ra=(id:string)=>refundAcct.filter(r=>r.payment_id===id)
    const aS=ss(A.paymentId),bS=ss(B.paymentId),cS=ss(C.paymentId), bRow=bS[0]
    const bOp=hB.ops.length===1?hB.ops[0]:null
    const aChecks={settlementRow:aS.length===1,noA2UMovement:aS.length===1&&!s(aS[0].a2u_txid)&&!s(aS[0].prepared_tx_hash),poisonedRefundRetired:rf(A.paymentId).length===1&&rr(A.paymentId).length===1,noRefundMovement:rf(A.paymentId).every(r=>!s(r.refund_txid))&&ra(A.paymentId).length===0,piU2ACompleted:piU2AExact(piA.payment,A,true,false)}
    const bChecks={settlementFinal:bS.length===1&&bRow.stage==="db_finalized"&&s(bRow.a2u_payment_id)===B.a2uPaymentId&&s(bRow.prepared_tx_hash)===B.txid&&s(bRow.a2u_txid)===B.txid&&n(bRow.customer_amount)===B.amount&&n(bRow.merchant_amount)===B.amount&&n(bRow.app_commission)===0&&!!bRow.horizon_confirmed_at&&!!bRow.pi_completed_at&&!!bRow.db_finalized_at,transactionExact:tt(B.paymentId).length===1&&n(tt(B.paymentId)[0].amount)===B.amount,receiptExact:rc(B.paymentId).length===1&&s(rc(B.paymentId)[0].a2u_identifier)===B.a2uPaymentId&&s(rc(B.paymentId)[0].a2u_txid)===B.txid&&n(rc(B.paymentId)[0].customer_amount)===B.amount&&n(rc(B.paymentId)[0].merchant_amount)===B.amount&&n(rc(B.paymentId)[0].app_commission)===0&&rc(B.paymentId)[0].settlement_status==="settled_to_merchant",noRefund:rf(B.paymentId).length===0&&ra(B.paymentId).length===0,piU2ACompleted:piU2AExact(piB.payment,B,true,false),piA2UCompleted:piBA2U.payment?.identifier===B.a2uPaymentId&&piBA2U.payment?.metadata?.paymentId===B.paymentId&&piBA2U.payment?.network==="Pi Testnet"&&piBA2U.payment?.direction==="app_to_user"&&n(piBA2U.payment?.amount)===B.amount&&bool(piBA2U.payment?.status?.developer_approved)&&bool(piBA2U.payment?.status?.transaction_verified)&&bool(piBA2U.payment?.status?.developer_completed)&&s(piBA2U.payment?.transaction?.txid)===B.txid,horizonExact:hB.tx?.hash===B.txid&&hB.tx?.successful===true&&hB.tx?.source_account===bRow.a2u_from_address&&String(hB.tx?.source_account_sequence)===String(bRow.prepared_sequence)&&hB.tx?.memo_type==="text"&&hB.tx?.memo===B.a2uPaymentId.substring(0,28)&&hB.tx?.operation_count===1&&!!bOp&&bOp.type==="payment"&&bOp.transaction_hash===B.txid&&bOp.transaction_successful===true&&bOp.from===bRow.a2u_from_address&&bOp.to===bRow.a2u_to_address&&bOp.asset_type==="native"&&n(bOp.amount)===B.amount}
    const cChecks={settlementRow:cS.length===1,noMovement:cS.length===1&&!s(cS[0].u2a_identifier)&&!s(cS[0].u2a_txid)&&!s(cS[0].a2u_payment_id)&&!s(cS[0].prepared_tx_hash)&&!s(cS[0].a2u_txid),r4jRetired:ur(C.paymentId).length===1&&ur(C.paymentId)[0].pi_payment_id===C.piPaymentId&&ur(C.paymentId)[0].reason==="pi_pretransaction_cancelled",piCancelledNoTransaction:piC.payment?.identifier===C.piPaymentId&&piC.payment?.metadata?.paymentId===C.paymentId&&piC.payment?.network==="Pi Testnet"&&piC.payment?.direction==="user_to_app"&&n(piC.payment?.amount)===C.amount&&bool(piC.payment?.status?.developer_approved)&&!bool(piC.payment?.status?.transaction_verified)&&!bool(piC.payment?.status?.developer_completed)&&(bool(piC.payment?.status?.cancelled)||bool(piC.payment?.status?.user_cancelled))&&piC.payment?.transaction==null,noTransactionReceiptRefund:tt(C.paymentId).length===0&&rc(C.paymentId).length===0&&rf(C.paymentId).length===0&&ra(C.paymentId).length===0}
    const globalChecks={duplicateIdentities:dups.length===0,refundDuplicateIdentities:refundDups.length===0,merchantBalanceMismatches:balances.length===0,settlementRefundOverlap:xor.length===0}
    const all=[...Object.values(aChecks),...Object.values(bChecks),...Object.values(cChecks),...Object.values(globalChecks)].every(Boolean)
    const evidence={ok:all,verdict:all?"DB_PI_HORIZON_RECONCILED":"MISMATCH",runId:RUN_ID,asOf:new Date().toISOString(),readOnly:true,financialMutationExecuted:false,piMutationExecuted:false,horizonSubmitExecuted:false,A:{classification:"PRESERVE_NO_ACTION",checks:aChecks},B:{classification:"NATURALLY_SETTLED",checks:bChecks,txid:B.txid},C:{classification:"R4J_RETIRED",checks:cChecks},global:{checks:globalChecks,totals,duplicateIdentityCount:dups.length,refundDuplicateIdentityCount:refundDups.length,merchantBalanceMismatchCount:balances.length,settlementRefundOverlapCount:xor.length}}
    console.warn("[FIN4 STEP13 FINAL RECONCILIATION]",JSON.stringify(evidence))
    return NextResponse.json(evidence,{status:all?200:409,headers:{"Cache-Control":"no-store"}})
  } catch(error) {
    console.error("[FIN4 STEP13 FINAL RECONCILIATION] INDETERMINATE",error)
    return NextResponse.json({ok:false,verdict:"INDETERMINATE",readOnly:true,financialMutationExecuted:false,piMutationExecuted:false,horizonSubmitExecuted:false},{status:503,headers:{"Cache-Control":"no-store"}})
  }
}
