import 'server-only'
type Row={payment_id:string;revision:string|number;lease_token:string}
type Ports={query:(sql:string,values:unknown[])=>Promise<unknown[]|null>;visit:(id:string)=>Promise<Response>;now:()=>number}
/** Discovery leases schedule work only. Every visit enters the unchanged
 * authenticated scope/SQL selectors; a lease is never a financial permission. */
export async function drainBoundedRecovery(p:Ports){
 const started=p.now(),rows=await p.query('SELECT * FROM public.r36_claim_recovery_work($1)',[8])
 if(!rows||rows.length>8)throw Error('RECOVERY_DISCOVERY_UNAVAILABLE')
 const seen=new Set<string>(),outcomes:{status:number;dispatch:string}[]=[]
 for(const row of rows){
  const r=row as Row
  if(!r||(typeof r.revision==='number'&&!Number.isSafeInteger(r.revision))||!/^\d+$/.test(String(r.revision))||BigInt(r.revision)<BigInt(1)||BigInt(r.revision)>BigInt('9223372036854775807')||
   !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.payment_id)||
   !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.lease_token)||seen.has(r.payment_id))throw Error('RECOVERY_DISCOVERY_INVALID')
  seen.add(r.payment_id)
 }
 for(const row of rows){
  const r=row as Row
  try{
   // Never cancel an in-flight financial executor to meet a scheduling budget.
   if(p.now()-started<20000){
    const response=await p.visit(r.payment_id),body=await response.json().catch(()=>null)
    outcomes.push({status:response.status,dispatch:typeof body?.dispatch==='string'?body.dispatch:'held'})
   }
  }catch{outcomes.push({status:503,dispatch:'dependency_held'})}
  finally{
   // Revision/token fencing prevents a late worker from erasing newer work.
   // PostgreSQL rechecks terminal evidence; the caller cannot request deletion.
   const ack=await p.query('SELECT public.r36_finish_recovery_work($1,$2,$3::uuid) AS acknowledged',[r.payment_id,String(r.revision),r.lease_token])
   if(ack?.length!==1||(ack[0] as {acknowledged?:boolean}).acknowledged!==true)outcomes.push({status:503,dispatch:'lease_expired_or_unacknowledged'})
  }
 }
 return {scope:'bounded_due_work',selected:rows.length,processed:outcomes.length,outcomes,
  financialOutcome:'verify_durable_result',discoveryGrantsFinancialAuthority:false}
}
