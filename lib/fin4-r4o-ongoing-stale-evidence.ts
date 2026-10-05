import "server-only"
import { query } from "@/lib/db"
import { redis, isRedisConfigured } from "@/lib/redis"
import { reconcileIncompleteA2UPayment, reconcilePiPayment, isRecord } from "@/lib/pi-reconciliation"

type Row=Record<string,unknown>
const s=(v:unknown)=>typeof v==="string"&&v.trim()!==""&&v===v.trim()?v:null
const n=(v:unknown)=>{const x=typeof v==="number"?v:typeof v==="string"?Number(v):NaN;return Number.isFinite(x)?x:null}
function safePi(dto:Record<string,unknown>|undefined){if(!dto)return null;const st=isRecord(dto.status)?dto.status:null;const tx=isRecord(dto.transaction)?dto.transaction:null;const md=isRecord(dto.metadata)?dto.metadata:null;return {identifier:s(dto.identifier),network:dto.network,direction:dto.direction,amount:dto.amount,user_uid:dto.user_uid,from_address:dto.from_address,to_address:dto.to_address,metadata:md,status:st,completed:dto.completed,cancelled:dto.cancelled,rejected:dto.rejected,transactionPresent:dto.transaction!=null,transactionTxid:s(tx?.txid)??s(dto.txid)??s(dto.transaction_id)}}
export async function readFin4R4OOngoingAndStaleEvidence(paymentA:string,paymentB:string){
 const rows=await query(`SELECT payment_id,stage,merchant_uid,customer_amount,u2a_identifier,u2a_txid,a2u_payment_id,a2u_from_address,a2u_to_address,prepared_tx_hash,prepared_sequence,a2u_txid AS movement_txid,horizon_confirmed_at,pi_completed_at,db_finalized_at,updated_at FROM settlement_checkpoints WHERE payment_id IN ($1,$2) OR (stage='a2u_created' AND a2u_payment_id IS NOT NULL) ORDER BY updated_at DESC LIMIT 100`,[paymentA,paymentB])
 if(!Array.isArray(rows))return {ok:false as const,outcome:"READ_INDETERMINATE" as const,reason:"POSTGRES_READ_FAILED",paymentA,paymentB,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
 const rr=rows as Row[];const a=rr.find(x=>x.payment_id===paymentA)??null;const b=rr.find(x=>x.payment_id===paymentB)??null
 const amount=a?n(a.customer_amount):null, uid=a?s(a.merchant_uid):null
 let projection:unknown=null,redisRead="UNAVAILABLE";if(isRedisConfigured){try{projection=await redis.get(`payment:${paymentA}`);redisRead="READ"}catch{redisRead="INDETERMINATE"}}
 const incomplete=a&&amount&&uid?await reconcileIncompleteA2UPayment(paymentA,amount,uid):{outcome:"INDETERMINATE" as const,paymentId:paymentA,reason:"DURABLE_INPUT_INCOMPLETE"}
 const p=isRecord(projection)?projection:null;const redisOngoingEvidence=p?.a2uErrorCode==="a2u_precreate_found_requires_reconciliation"&&p?.settlementFailureState==="held"
 const durableOngoingIdentifier=a?s(a.a2u_payment_id):null
 const old=rr.find(x=>x.payment_id!==paymentA&&x.payment_id!==paymentB&&x.stage==="a2u_created"&&s(x.a2u_payment_id)!==null)??null
 const oldId=old?s(old.a2u_payment_id):null;const oldPi=oldId?await reconcilePiPayment(oldId):null;const oldSafe=oldPi?.dto?safePi(oldPi.dto):null
 const oldCancelled=Boolean(oldSafe&&(oldSafe.cancelled===true||(isRecord(oldSafe.status)&&((oldSafe.status as Row).cancelled===true||(oldSafe.status as Row).user_cancelled===true))) )
 const staleAuthority=Boolean(old&&oldId&&oldCancelled&&old.stage==="a2u_created"&&!s(old.movement_txid)&&!s(old.prepared_tx_hash))
 const identifierGap=Boolean(redisOngoingEvidence&&durableOngoingIdentifier===null&&incomplete.outcome==="CONFIRMED_NONE")
 const outcome=identifierGap&&staleAuthority?"ONGOING_ID_NOT_DURABLY_CAPTURED_AND_STALE_CANCELLED_AUTHORITY":identifierGap?"ONGOING_ID_NOT_DURABLY_CAPTURED":staleAuthority?"STALE_CANCELLED_AUTHORITY_CONFIRMED":"NO_COMBINED_FINDING"
 return {ok:true as const,outcome,paymentA,paymentB,currentA:{durableStage:a?.stage??null,durableA2uPaymentId:durableOngoingIdentifier,redisRead,redisOngoingEvidence,redisErrorCode:p?.a2uErrorCode??null,redisFailureState:p?.settlementFailureState??null,incompleteOutcome:incomplete.outcome,incompleteReason:incomplete.reason,incompleteCandidate:incomplete.dto?safePi(incomplete.dto):null,ongoingIdentifierDurablyCaptured:durableOngoingIdentifier!==null},staleAuthority:{confirmed:staleAuthority,paymentId:old?s(old.payment_id):null,a2uPaymentId:oldId,durableStage:old?.stage??null,preparedHash:s(old?.prepared_tx_hash),movementTxid:s(old?.movement_txid),piOutcome:oldPi?.outcome??null,piReason:oldPi?.reason??null,pi:safePi(oldPi?.dto),piCancelled:oldCancelled},financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
}
