import "server-only"
import {
  readSettlementU2APretransactionRecoveryCandidate,
  retireSettlementU2AApprovalAfterCanonicalCancellation,
} from "@/lib/db"
import { serverConfig } from "@/lib/server-config"

const C_PAYMENT="a0553edf-8784-4758-a246-2da36847a3b8"
const C_PI="JYJ36kpTyzUPuEFd0uJIWAynLCJK"

type R=Record<string,unknown>
const rec=(v:unknown):v is R=>typeof v==="object"&&v!==null&&!Array.isArray(v)
const exact=(v:unknown)=>typeof v==="string"&&v.trim()!==""&&v===v.trim()?v:null
const status=(p:R)=>rec(p.status)?p.status:null
const noTx=(p:R)=>p.transaction==null&&exact(p.txid)==null&&exact(p.transaction_id)==null

async function getPi():Promise<{ok:true;pi:R}|{ok:false;status:number|null}>{
  try{
    const r=await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(C_PI)}`,{
      headers:{Authorization:`Key ${serverConfig.piApiKey}`},cache:"no-store"
    })
    if(!r.ok)return{ok:false,status:r.status}
    const p:unknown=await r.json().catch(()=>null)
    return rec(p)?{ok:true,pi:p}:{ok:false,status:null}
  }catch{return{ok:false,status:null}}
}

/*
 * R4T6.3.1 C-only cleanup.
 * C is a cancelled U2A PRE-TRANSACTION approval. It has no Pi transaction,
 * txid, A2U source wallet, prepared XDR or Horizon-addressable transaction.
 * Never manufacture a wallet-based Horizon proof from absent identity.
 *
 * The durable retirement primitive is CAS-guarded to a pristine
 * payment_identity row with no U2A/A2U/Horizon progress. Canonical Pi must
 * independently prove cancelled + transaction=null. Any contradiction fails closed.
 */
export async function retireC(){
  if(!serverConfig.isPiApiKeyConfigured)
    return{ok:false,outcome:"PI_UNAVAILABLE",piMutationExecuted:false,horizonSubmitExecuted:false}

  const c=await readSettlementU2APretransactionRecoveryCandidate(C_PAYMENT,C_PI)
  if(c.outcome!=="CANDIDATE")
    return{ok:false,outcome:"C_NOT_PRISTINE_PRETRANSACTION_CANDIDATE",candidate:c.outcome,piMutationExecuted:false,horizonSubmitExecuted:false}

  const before=await getPi()
  if(!before.ok)
    return{ok:false,outcome:"C_PI_READ_INDETERMINATE",piMutationExecuted:false,horizonSubmitExecuted:false}

  const s=status(before.pi)
  const canonicalCancelledNoTransaction=
    before.pi.identifier===C_PI &&
    rec(before.pi.metadata) &&
    before.pi.metadata.paymentId===C_PAYMENT &&
    before.pi.network==="Pi Testnet" &&
    before.pi.direction==="user_to_app" &&
    before.pi.amount===c.customerAmount &&
    s?.developer_approved===true &&
    s?.transaction_verified===false &&
    s?.developer_completed===false &&
    (s?.cancelled===true||s?.user_cancelled===true) &&
    noTx(before.pi)

  if(!canonicalCancelledNoTransaction)
    return{ok:false,outcome:"C_CANONICAL_CANCELLED_PRETRANSACTION_NOT_PROVEN",piMutationExecuted:false,horizonSubmitExecuted:false}

  // Deliberately NO Pi cancel POST and NO Horizon submit/read assertion.
  // With transaction=null and no canonical source address/txid, Horizon has
  // no exact C identity to query; absence is enforced by pristine durable CAS
  // plus canonical Pi cancelled/no-transaction evidence.
  const r=await retireSettlementU2AApprovalAfterCanonicalCancellation({
    paymentId:C_PAYMENT,piPaymentId:C_PI,piCancelledAt:new Date().toISOString()
  })

  return{
    ok:r.outcome==="RETIRED"||r.outcome==="REPLAYED",
    outcome:r.outcome,
    paymentId:C_PAYMENT,
    piPaymentId:C_PI,
    proof:"CANONICAL_PI_CANCELLED_NO_TRANSACTION_PLUS_PRISTINE_DURABLE_CAS",
    piAlreadyCancelled:true,
    piMutationExecuted:false,
    horizonReadExecuted:false,
    horizonSubmitExecuted:false,
    financialAuthorityMutated:r.outcome==="RETIRED",
  }
}
