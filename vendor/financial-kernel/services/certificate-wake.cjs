'use strict';
// Operational notification only. Original Vercel/SQL guards own every financial
// decision. This module never receives a wallet key, a payment body or a DB role.
const fs=require('node:fs'),path=require('node:path');
const ENDPOINT=require('/kernel/dist/deployment.js').deployment().publicOrigin+'/api/recovery/new-intents';
function createWake(ports){let busy=false;return{async pulse(event,policy){
 if(busy||!policy)return{status:'NO_CERTIFICATE_EVENT'};
 busy=true;try{
  const now=ports.now(),config=ports.config(),prior=ports.read();
  const published=event.dispatchStatus==='PUBLISHED_REQUIRES_ORIGINAL_R36_GUARDS'&&Number.isSafeInteger(event.published)&&event.published>0&&event.held===0;
  // This hints at unfinished, already-completed accounting; the original
  // authenticated handler independently proves and records finality.
  const terminalPending=event.lifecycleStatus==='WAITING_FOR_ORIGINAL_TERMINAL_FACTS'&&event.dispatchStatus==='IDLE_NO_CANDIDATE'&&event.jobs===0&&event.published===0&&event.held===0&&Number.isSafeInteger(event.policies)&&event.policies>0;
  if(config.schema!=='R36_CERTIFICATE_EVENT_WAKE_V1'||config.policyDigest!==policy||config.enabled!==true||!Number.isFinite(Date.parse(event.at))||Math.abs(now-Date.parse(event.at))>30000)return{status:'EVENT_WAKE_HELD'};
  if(prior&&(!Number.isSafeInteger(prior.count)||prior.count<0||prior.count>60||!Number.isFinite(prior.lastAttemptAt)||prior.lastAttemptAt>now))return{status:'EVENT_WAKE_STATE_HELD'};
  let pending=prior?.pending||null;
  if(pending&& (pending.policy!==policy||!Number.isFinite(pending.startedAt)||!Number.isFinite(pending.until)||pending.startedAt>now||pending.until!==pending.startedAt+600000||!Number.isSafeInteger(pending.attempts)||pending.attempts<1||pending.attempts>12))return{status:'EVENT_WAKE_STATE_HELD'};
  if(pending&&(pending.until<=now||pending.attempts>=12))pending=null;
  if(!published&&!terminalPending&&!pending)return{status:'NO_CERTIFICATE_EVENT'};
  if(prior&&now-prior.lastAttemptAt<5000)return{status:'EVENT_WAKE_COALESCED'};
  const day=new Date(now).toISOString().slice(0,10),count=prior?.day===day?prior.count:0;if(count>=60)return{status:'EVENT_WAKE_DAILY_LIMIT'};
  // This is a durable notification continuation, never a financial permission.
  // Every wake re-enters the unchanged SQL selector and original executors. A
  // confirmed preparation changes the frozen evidence snapshot legitimately;
  // subsequent checkpoint work must not depend on issuing the same proof again.
  const next={day,count:count+1,lastAttemptAt:now,pending:pending?{...pending,attempts:pending.attempts+1}:{policy,startedAt:now,until:now+600000,attempts:1}};
  ports.save(next);
  try{
   const r=await ports.send(ENDPOINT);
   const more=r.status===200&&['preparation_invoked','refund_invoked','refund_finalization_invoked','refund_projection_invoked','settlement_invoked','terminal_seal_recorded','terminal_seal_held','executor_held'].includes(r.dispatch);
   if(r.status===200&&!more)ports.save({...next,pending:null});
   return{status:r.status===200?'EVENT_WAKE_DELIVERED':'EVENT_WAKE_REJECTED',httpStatus:r.status,dispatch:r.dispatch,continuation:more,at:new Date(now).toISOString()};
  }catch{return{status:'EVENT_WAKE_DELIVERY_UNCERTAIN',at:new Date(now).toISOString()}}
 }catch{return{status:'EVENT_WAKE_FAILED_CLOSED'}}finally{busy=false}
}}}
function production(root,load){
 const state=path.join(root,'scratch/CERTIFICATE_WAKE_BUDGET.json'),configuration=path.join(root,'CERTIFICATE_WAKE.json');
 let delivering=false;
 const flight=path.join(root,'scratch/CERTIFICATE_WAKE_INFLIGHT.json');
 function activity(active){const data={active,hostBootId:process.env.R36_HOST_BOOT_ID||null,startedAt:new Date().toISOString()};const tmp=flight+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data),{mode:0o600});fs.renameSync(tmp,flight);delivering=active}
 function readPrivate(file,optional=false){try{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.size>4096)throw Error('STORAGE');return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(optional&&e.code==='ENOENT')return null;throw e}}
 const wake=createWake({now:()=>Date.now(),config:()=>readPrivate(configuration),read:()=>readPrivate(state,true),save:s=>{const temp=state+'.tmp';fs.writeFileSync(temp,JSON.stringify(s),{mode:0o600});fs.renameSync(temp,state)},send:async()=>{
  const credential=load('recovery');if(typeof credential.secret!=='string'||!/^[A-Za-z0-9_-]{64}$/.test(credential.secret))throw Error('CREDENTIAL_UNAVAILABLE');
  activity(true);
  try{
  const response=await fetch(ENDPOINT,{method:'POST',headers:{'x-flashpay-transient-recovery-secret':credential.secret},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(90000)});
  const body=await response.json().catch(()=>null);return{status:response.status,dispatch:typeof body?.dispatch==='string'&&/^[a-z_]+$/.test(body.dispatch)?body.dispatch:undefined};
  }finally{activity(false)}
 }});
 return {...wake,deliveryActive:()=>delivering};
}
module.exports={createWake,production,ENDPOINT};
