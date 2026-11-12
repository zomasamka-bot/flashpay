import {validateMerchantFeeQuote, type MerchantFeeQuote} from './merchant-fee-contract'
import {numberToExactPositiveStroops} from './financial-amount-stroops'
export type {MerchantFeeQuote}
const units=(n:unknown):number|null => typeof n === 'number' && n === 0 ? 0 : typeof n === 'number' ? numberToExactPositiveStroops(n) : null
export function financialAmountsMatch(gross:unknown,net:unknown,commission:unknown,quote?:unknown):boolean {
 if(quote==null)return typeof gross==='number'&&Number.isFinite(gross)&&gross>0&&net===gross&&commission===0
 try {const q=validateMerchantFeeQuote(quote);return String(units(gross))===q.grossStroops&&String(units(net))===q.merchantNetStroops&&String(units(commission))===q.commissionStroops}catch{return false}
}
export function paymentFinancialAmountsMatch(p:{id?:string;merchantUid?:string;customerAmount?:number;merchantAmount?:number;appCommission?:number;financialContract?:MerchantFeeQuote}):boolean {
 if(!financialAmountsMatch(p.customerAmount,p.merchantAmount,p.appCommission,p.financialContract))return false
 return !p.financialContract||(p.financialContract.paymentId===p.id&&p.financialContract.merchantUid===p.merchantUid)
}
export function settlementTarget(p:{customerAmount?:number;amount?:number;financialContract?:MerchantFeeQuote}):number {
 if(p.financialContract){const q=validateMerchantFeeQuote(p.financialContract);if(String(units(p.customerAmount??p.amount))!==q.grossStroops)throw Error('FINANCIAL_QUOTE_GROSS_MISMATCH');return Number(q.merchantNetStroops)/1e7}
 const amount=p.customerAmount??p.amount;if(typeof amount!=='number'||!Number.isFinite(amount)||amount<=0)throw Error('FINANCIAL_GROSS_REQUIRED');return amount
}
export function contractCommission(p:{financialContract?:MerchantFeeQuote}):number {return p.financialContract?Number(validateMerchantFeeQuote(p.financialContract).commissionStroops)/1e7:0}
export function netImpact(gross:number,net:number,fee:number,quote?:unknown):number {
 if(quote==null)return gross-net-fee
 const q=validateMerchantFeeQuote(quote),f=units(fee)
 if(f===null||!financialAmountsMatch(gross,net,Number(q.commissionStroops)/1e7,q))throw Error('FINANCIAL_NET_IMPACT_MISMATCH')
 return Number(BigInt(q.commissionStroops)-BigInt(f))/1e7
}
/** Only callers holding the original PostgreSQL row may supply this value.
 * A valid quote alone never grants authority; identity, certificates and XOR still apply. */
export function financialContractFromRow(row:Record<string,unknown>):MerchantFeeQuote|undefined {
 const value=row.financial_contract;if(value==null)return undefined
 const q=validateMerchantFeeQuote(value)
 if(q.paymentId!==row.payment_id||q.merchantUid!==row.merchant_uid||!financialAmountsMatch(Number(row.customer_amount),Number(row.merchant_amount),Number(row.app_commission),q))throw Error('DURABLE_FINANCIAL_CONTRACT_MISMATCH')
 return q
}
