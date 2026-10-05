import 'server-only'
import { getSettlementCheckpointAuthoritative } from './db'
export type Fin4R4TSourceWalletResolution =
 | {ok:true;paymentB:string;sourceWallet:string;authority:'postgres_settlement_checkpoint_a2u_created'}
 | {ok:false;reason:'ARMED_PAYMENT_B_UNAVAILABLE'|'DURABLE_STAGE1_SOURCE_WALLET_UNPROVEN';paymentB?:string;durableOutcome?:string;durableStage?:string|null}
export async function resolveFin4R4TSourceWallet():Promise<Fin4R4TSourceWalletResolution>{
 const paymentB=process.env.FLASHPAY_FIN4_PAYMENT_B?.trim()??''
 if(!paymentB)return{ok:false,reason:'ARMED_PAYMENT_B_UNAVAILABLE'}
 const durable=await getSettlementCheckpointAuthoritative(paymentB)
 if(durable.outcome!=='FOUND'||durable.checkpoint.paymentId!==paymentB||durable.checkpoint.stage!=='a2u_created'||!durable.checkpoint.a2uFromAddress||durable.checkpoint.a2uFromAddress!==durable.checkpoint.a2uFromAddress.trim()||durable.checkpoint.preparedEnvelopeXdr!==undefined||durable.checkpoint.preparedTxHash!==undefined||durable.checkpoint.preparedSequence!==undefined||durable.checkpoint.a2uTxid!==undefined)
  return{ok:false,reason:'DURABLE_STAGE1_SOURCE_WALLET_UNPROVEN',paymentB,durableOutcome:durable.outcome,durableStage:durable.outcome==='FOUND'?durable.checkpoint.stage:null}
 return{ok:true,paymentB,sourceWallet:durable.checkpoint.a2uFromAddress,authority:'postgres_settlement_checkpoint_a2u_created'}
}
