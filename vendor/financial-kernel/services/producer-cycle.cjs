'use strict';
// Dispatch an actual queued right first. register() still performs the original
// independent bound-closure path. Do not perform a second unbound review that
// cannot exclude this pending successor. Idle/held cycles retain prior review.
async function runProducerCycle({automatic,dispatch,now=Date.now}){
 const started=now();automatic.beginCycle();
 const dispatchedAt=now(),result=await dispatch(),dispatchMs=now()-dispatchedAt;
 const accepted=automatic.registeredResult(),preparedAt=now();
 const initial=accepted||await automatic.prepare();
 const lifecycle=automatic.cycleResult(initial);
 return {result,lifecycle,timing:{dispatchMs,lifecycleMs:now()-preparedAt,totalMs:now()-started,boundAdmissionInThisCycle:!!accepted}};
}
module.exports={runProducerCycle};
