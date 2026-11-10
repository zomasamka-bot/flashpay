// An activity hint only. This never supplies an amount, request identity or
// financial permission; the existing server verifies Pi identity independently.
type Identity={uid?:string;merchantId?:string;accessToken?:string}
export function createMerchantActivityPrewarm(send:typeof fetch,now=Date.now){
 let active=false,lastIdentity='',nextAt=0
 return async(identity:Identity):Promise<void>=>{
  const {uid,merchantId,accessToken}=identity
  if(!uid||!merchantId||!accessToken)return
  const key=JSON.stringify([uid,merchantId]),at=now()
  if(active||(key===lastIdentity&&at<nextAt))return
  active=true;lastIdentity=key;nextAt=at+60000
  try{
   const response=await send('/api/pi/verify-uid',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({uid,merchantId,accessToken}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)})
   if(!response.ok)nextAt=now()+10000
  }catch{nextAt=now()+10000}finally{active=false}
 }
}
