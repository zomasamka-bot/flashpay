"use strict";
// One reader cycle at a time. A verified operational progress notification can
// advance the next read; it never grants authority or retries a financial POST.
function createProducerScheduler(p){
 let active=false, pending=false, closed=false, timer=null;
 async function run(){
  if(closed)return;
  if(active){pending=true;return}
  active=true;pending=false;if(timer!==null){p.clear(timer);timer=null}
  try{
   const delay=await p.cycle();
   if(!closed){const next=pending?0:delay;pending=false;timer=p.set(()=>{timer=null;void run()},next)}
  }catch(e){closed=true;p.fail(e)}finally{active=false}
 }
 return {start:run,kick:()=>{void run()},stop:()=>{closed=true;pending=false;if(timer!==null)p.clear(timer);timer=null}};
}
module.exports={createProducerScheduler};
