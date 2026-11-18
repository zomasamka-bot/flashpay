// Reuse exactly one persisted intent/body; never mint a replacement on uncertainty.
export async function sendPaymentCreation(url:string,body:string,ports:{send:typeof fetch;pause:(ms:number)=>Promise<void>}={send:(...args)=>fetch(...args),pause:ms=>new Promise(r=>setTimeout(r,ms))}):Promise<Response>{
 for(let attempt=0;;attempt++){
  let response:Response
  try{response=await ports.send(url,{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(60000)})}
  catch(error){if(attempt>=2)throw error;await ports.pause(250*2**attempt);continue}
  if(response.status!==503||attempt>=2)return response
  let code:unknown;try{code=(await response.clone().json()).code}catch{return response}
  if(!['PAYMENT_CREATE_UNCERTAIN','PAYMENT_SERVICES_UNAVAILABLE','PAYMENT_ADMISSION_UNAVAILABLE','PAYMENT_PROJECTION_PENDING','CREATE_INTENT_RECOVERY_REQUIRED','PI_IDENTITY_UNAVAILABLE','PAYMENT_REDIS_UNAVAILABLE','PAYMENT_CREATE_LEASE_UNAVAILABLE'].includes(String(code)))return response
  await ports.pause(250*2**attempt)
 }
}
