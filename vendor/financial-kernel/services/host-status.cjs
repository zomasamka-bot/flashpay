'use strict';
const fs=require('node:fs');
function read(p){try{return JSON.parse(fs.readFileSync(p))}catch{return null}}
const boot=read('/run/flashpay-r36/boot.json');
const state=read('/data/r36/scratch/DURABLE_STATUS.json');
const dispatch=read('/data/r36/scratch/DISPATCH_STATUS.json');
const notification=read('/data/r36/scratch/CERTIFICATE_WAKE_INFLIGHT.json');
let alive=false;
if(boot&&state?.hostBootId===boot.id&&Number.isSafeInteger(state.pid)&&state.pid>1){
 try{process.kill(state.pid,0);alive=true}catch{}
}
// Return only operational metadata. Never include TLS material or database URLs.
console.log(JSON.stringify({boot:boot&&{id:boot.id,startedAt:boot.startedAt},alive,
notification:notification&&{active:notification.active===true,hostBootId:notification.hostBootId,startedAt:notification.startedAt},state:state&&{
 hostBootId:state.hostBootId,running:state.running,heartbeatAt:state.heartbeatAt,readyAt:state.readyAt,
 configuredPolicyDigest:state.configuredPolicyDigest,generation:state.generation,services:state.services?.map(s=>s.result),startupTiming:state.startupTiming
},dispatch:dispatch&&{at:dispatch.at,dispatchStatus:dispatch.dispatchStatus,lifecycleStatus:dispatch.lifecycleStatus,held:dispatch.held,policies:dispatch.policies,timing:dispatch.timing}}));
