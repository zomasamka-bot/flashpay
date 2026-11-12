import {financialIncomingWallet} from './financial-network'
import 'server-only'
import {getR36RestrictedClient,recordSettlementU2AVerifiedCheckpoint} from './db'
import {serverConfig} from './server-config'
import {verifyTestnetInbound} from './r36-testnet-ingress'

// Only a durable, admitted, original approval claim may choose the provider ID.
// No client URL, token, Redis projection or financial POST is accepted here.
export async function observeUnrecordedInbound(subject:string|null,policy:string):Promise<boolean>{
 try {
  if(!serverConfig.piApiKey)return false
  const db=await getR36RestrictedClient();if(!db)return false
  const rows=await db.unsafe('SELECT public.r36_next_inbound_observation($1,$2) AS candidate',[subject,policy])
  const c=rows.length===1?rows[0].candidate:null
  if(!c)return false
  if(typeof c.payment_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.payment_id)||
   (subject!==null&&c.payment_id!==subject)||typeof c.pi_payment_id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(c.pi_payment_id)||
   typeof c.amount_stroops!=='string'||!/^[1-9][0-9]{0,13}$/.test(c.amount_stroops)||BigInt(c.amount_stroops)>BigInt('10000000000000'))return false
  const r=await fetch('https://api.minepi.com/v2/payments/'+encodeURIComponent(c.pi_payment_id),{
   method:'GET',headers:{Authorization:'Key '+serverConfig.piApiKey},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)})
  if(!r.ok)return false
  const p=await r.json()
  if(p?.identifier!==c.pi_payment_id||p?.metadata?.paymentId!==c.payment_id||p?.user_uid!==c.payer_uid||
    p?.to_address!==financialIncomingWallet()||typeof p?.amount!=='number'||p.amount!==Number(c.amount_stroops)/10000000||
    !await verifyTestnetInbound(p))return false
  const recorded=await recordSettlementU2AVerifiedCheckpoint({paymentId:c.payment_id,merchantId:c.merchant_id,
   merchantUid:c.merchant_uid,customerAmount:p.amount,payerUid:c.payer_uid,u2aIdentifier:c.pi_payment_id,u2aTxid:p.transaction.txid})
  return recorded.outcome==='RECORDED'||recorded.outcome==='REPLAYED'
 }catch{return false}
}
