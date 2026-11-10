/** Retry only an explicit pre-admission service warm-up refusal. Never retry an
 * ambiguous response, manufacture another intent, or change the request body. */
export async function sendPaymentCreation(url:string,body:string,ports:{send:typeof fetch;pause:(ms:number)=>Promise<void>}={send:(...args)=>fetch(...args),pause:ms=>new Promise(r=>setTimeout(r,ms))}):Promise<Response>{
 for(let attempt=0;;attempt++){
  const response=await ports.send(url,{method:'POST',headers:{'Content-Type':'application/json'},body})
  if(response.status!==503||attempt>=2)return response
  let code:unknown
  try{code=(await response.clone().json()).code}catch{return response}
  if(code!=='PAYMENT_SERVICES_UNAVAILABLE')return response
  await ports.pause(2000)
 }
}
