/** Advance only the already-submitted operation through its original confirmed
 * selectors. A wake is not authority; every step must reselect the exact right.
 * No preparation, submission, alternate payment or consumed authority is reused.
 */
import type {ScopedRecoveryRight} from './r36-recovery-scope'
type Right=ScopedRecoveryRight
type Select=(right:Right)=>boolean
const progressed=new Set(['settlement_invoked','refund_invoked','refund_finalization_invoked','refund_projection_invoked'])
const confirmed={settlement:new Set(['horizon_confirmed','pi_completed']),refund:new Set(['wallet_submission_confirmed','payment_checkpoint_updated','accounting_recorded','audit_recorded','completed_projection'])}
const key=(r:Right)=>JSON.stringify([r.id,r.kind,r.op,r.wallet,r.hash,r.seq,r.stage,r.spent])
const same=(a:Right,b:Right)=>['id','kind','op','wallet','hash','seq'].every(k=>a[k as keyof Right]===b[k as keyof Right])
export async function continueR36ConfirmedOperation(first:Right,result:string,ports:{step(select:Select):Promise<string>;seal():Promise<string|null>;now?:()=>number}):Promise<string>{
 if(!progressed.has(result))return result
 const now=ports.now??Date.now,deadline=now()+15000,seen=new Set([key(first)])
 let last=result,selected=false
 // Five refund checkpoints plus a final selector read; no polling or sleeps.
 for(let n=0;n<6&&now()<deadline;n++){
  selected=false
  const next=await ports.step(r=>{
   if(!same(first,r)||r.spent!==true||!confirmed[r.kind]?.has(r.stage))throw Error('R36_CONFIRMED_CONTINUATION_IDENTITY')
   const k=key(r);if(seen.has(k))return false
   seen.add(k);selected=true;return true
  })
  if(next==='no_confirmed_right'){
   const terminal=await ports.seal()
   return terminal??last
  }
  if(!selected||!progressed.has(next))return last
  last=next
 }
 return last
}
