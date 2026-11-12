"use strict";
// Process-local activity; a prior idle result cannot stop an in-flight cycle.
// Missing or malformed activity always keeps the worker alive until its lease.
function createCycleActivity(){
 let active=true, completedAt=null;
 return {
  observe(event){
   if(event?.producerCycle==='started'){active=true;completedAt=null;return}
   if(typeof event?.dispatchStatus==='string' && Number.isFinite(Date.parse(event.at))){active=false;completedAt=event.at}
  },
  canIdleStop({now,lastWake,dispatch,pending}){
   return !active && completedAt!==null && dispatch?.at===completedAt &&
    Number.isFinite(now)&&Number.isFinite(lastWake)&&now>=lastWake&&now-lastWake>60000 &&
    now>=Date.parse(completedAt)&&now-Date.parse(completedAt)<=30000 &&
    dispatch.dispatchStatus==='IDLE_NO_CANDIDATE'&&dispatch.jobs===0&&dispatch.published===0&&dispatch.held===0&&pending===false;
  }
 };
}
module.exports={createCycleActivity};
