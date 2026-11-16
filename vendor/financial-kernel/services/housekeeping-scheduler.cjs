'use strict';
// Cleanup owns no financial permission. One bounded task at a time; failures
// retain originals. Run independently of the frequency of financial cycles.
function createHousekeepingScheduler(p){
 let flight=null,closed=false,timer=null;
 function kick(){
  if(closed)return Promise.resolve(null);
  if(flight)return flight;
  if(timer!==null){p.clear(timer);timer=null}
  flight=(async()=>{
   const start=p.now();let checked=0,released=0,retained=0;
   for(let n=0;n<8&&p.now()-start<20000;n++){
    if(p.canRun&&!p.canRun())break;
    const r=await p.pass();checked+=r.checked;released+=r.released;retained+=r.retained;
    if(!r.checked||!r.released)break;
   }
   return{checked,released,retained};
  })().then(r=>{p.report(r);return r},()=>{p.failed();return null}).finally(()=>{
   flight=null;if(!closed)timer=p.set(()=>{timer=null;void kick()},5000);
  });
  return flight;
 }
 return{kick,stop(){closed=true;if(timer!==null)p.clear(timer);timer=null}};
}
module.exports={createHousekeepingScheduler};
