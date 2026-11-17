'use strict';
// Retry only a coalesced operational notification at its original rate-limit
// boundary. Never retry a rejected/uncertain delivery or supply financial rights.
function createCertificateDelivery(p){
 let closed=false,active=false,pending=null,timer=null;
 function cancel(){if(timer!==null){p.clear(timer);timer=null}}
 async function run(){
  if(closed||active||!pending)return;
  const event=pending;pending=null;active=true;
  try{
   const result=await p.pulse(event);
   if(closed)return;
   p.result(result);
   if(!pending&&result.status==='EVENT_WAKE_COALESCED'&&
      Number.isSafeInteger(result.retryAfterMs)&&result.retryAfterMs>0&&result.retryAfterMs<=5000&&
      Number.isFinite(Date.parse(event.at))&&p.now()+result.retryAfterMs-Date.parse(event.at)<=30000){
    pending=event;
    timer=p.set(()=>{timer=null;void run()},result.retryAfterMs);
   }
  }catch{p.failed()}finally{
   active=false;
   if(!closed&&pending&&timer===null)void run();
  }
 }
 return{push(event){if(closed)return;cancel();pending=event;void run()},stop(){closed=true;pending=null;cancel()}};
}
module.exports={createCertificateDelivery};
