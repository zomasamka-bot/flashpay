import {financialAmountsMatch,paymentFinancialAmountsMatch,settlementTarget,contractCommission,netImpact,financialContractFromRow} from './payment-financial-contract'
import {numberToExactPositiveStroops} from './financial-amount-stroops'
import type {FlashPayReceiptView} from './types'
import {normalizeReceiptName} from './receipt-presentation'
type Row=Record<string,any>
export type ReceiptIdentity={uid:string;username:string}
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const time=(v:unknown)=>v instanceof Date?v.toISOString():typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null
/** Read-only projection of an exact original checkpoint/transaction/receipt pair.
 * A cached Redis amount, username or status never supplies financial authority. */
export function buildDurableSettlementReceipt(value:unknown,viewer:ReceiptIdentity):FlashPayReceiptView|null {
 if(!object(value)||!object(value.checkpoint)||!object(value.receipt)||!object(value.transaction)||!object(value.intent)||value.refund!==null)return null
 const s=value.checkpoint,r=value.receipt,t=value.transaction,i=value.intent
 if(!viewer.uid||!(s.merchant_uid===viewer.uid&&s.merchant_id===viewer.username||s.payer_uid===viewer.uid))return null
 const amount=Number(s.customer_amount),net=Number(s.merchant_amount),commission=Number(s.app_commission)
 try{financialContractFromRow(s)}catch{return null}
 if(!Number.isFinite(amount)||amount<=0||Number(amount.toFixed(7))!==amount||s.stage!=='db_finalized'||
 !time(s.db_finalized_at)||!time(s.pi_completed_at)||!time(s.horizon_confirmed_at)||
 !/^[0-9a-f]{64}$/.test(s.a2u_txid)||s.a2u_txid!==s.prepared_tx_hash||
 s.app_commission===null||s.merchant_amount===null||!financialAmountsMatch(amount,net,commission,s.financial_contract)||
 i.payment_id!==s.payment_id||i.merchant_uid!==s.merchant_uid||i.merchant_id!==s.merchant_id||Number(i.customer_amount)!==amount||
 t.payment_id!==s.u2a_identifier||t.status!=='completed'||t.currency!=='π'||Number(t.amount)!==net||
 t.merchant_uid!==s.merchant_uid||t.merchant_id!==s.merchant_id||r.transaction_id!==t.id||
 r.merchant_uid!==s.merchant_uid||r.merchant_id!==s.merchant_id||r.currency!=='π'||
 r.amount===null||Number(r.amount)!==net||r.customer_amount===null||Number(r.customer_amount)!==amount||
 r.merchant_amount===null||Number(r.merchant_amount)!==net||r.app_commission===null||Number(r.app_commission)!==commission||
 r.u2a_identifier!==s.u2a_identifier||r.u2a_txid!==s.u2a_txid||r.a2u_identifier!==s.a2u_payment_id||
 r.a2u_txid!==s.a2u_txid||r.txid!==s.a2u_txid||
 s.horizon_fee_stroops===null||r.horizon_fee_charged===null||(Number(r.horizon_fee_charged)===0?0:numberToExactPositiveStroops(Number(r.horizon_fee_charged)))!==Number(s.horizon_fee_stroops)||
 r.app_net_impact===null||Number(r.app_net_impact)!==netImpact(amount,net,Number(r.horizon_fee_charged),s.financial_contract)||r.settlement_status!=='settled_to_merchant')return null
 const occurredAt=time(r.timestamp??r.created_at);if(!occurredAt)return null
 return {...(s.financial_contract&&s.merchant_uid===viewer.uid&&s.merchant_id===viewer.username?{merchantFinancials:{commission,net,policyId:s.financial_contract.policy.id}}:{}),flashPayPaymentId:s.payment_id,merchantName:s.merchant_id,customerName:normalizeReceiptName(r.payer_username) ?? (s.payer_uid===viewer.uid ? normalizeReceiptName(viewer.username) : verifiedReceiptPayerName(value.payerProjection,s)),
 amount,currency:'π',transactionType:'payment',status:'successful',occurredAt,note:typeof i.note==='string'?i.note.trim()||null:null}
}

/** Presentation only: an exact server-verified payer projection cannot authorize money. */
export function verifiedReceiptPayerName(projection:unknown,checkpoint:unknown):string|null {
 if(!object(projection)||!object(checkpoint)||projection.id!==checkpoint.payment_id||
 projection.payerUidSource!=='verified_u2a'||!checkpoint.payer_uid||projection.payerUid!==checkpoint.payer_uid||
 projection.piPaymentId!==checkpoint.u2a_identifier||projection.merchantId!==checkpoint.merchant_id)return null
 return normalizeReceiptName(projection.payerUsername)
}
