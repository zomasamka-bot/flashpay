'use strict';
// Operational timing only. No request bodies, SQL, identities or credentials.
function createPhaseTrace({emit,now=Date.now,clock=performance.now.bind(performance),capacity=256}){
 let sequence=0;const events=[];
 function record(v){try{events.push(v);while(events.length>capacity)events.shift();emit(v)}catch{}}
 async function run(phase,operation){
  if(!/^[a-z_]{1,40}$/.test(phase))throw Error('TRACE_PHASE');
  const id=++sequence,start=clock();record({r36Phase:phase,phaseId:id,event:'start',at:new Date(now()).toISOString()});
  try{const result=await operation();record({r36Phase:phase,phaseId:id,event:'end',at:new Date(now()).toISOString(),ms:Math.round(clock()-start),outcome:'returned'});return result}
  catch(error){record({r36Phase:phase,phaseId:id,event:'end',at:new Date(now()).toISOString(),ms:Math.round(clock()-start),outcome:'rejected'});throw error}
 }
 return {run,snapshot:()=>events.map(x=>({...x}))};
}
module.exports={createPhaseTrace};
