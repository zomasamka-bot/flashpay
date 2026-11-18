import { CoreLogger } from "./core"
import { config } from "./config"

// Shared Home and balance consent path. Keep the original incomplete-payment
// callback: the guarded server remains the only authority for its completion.
export async function authenticatePiWalletSession(): Promise<any> {
 if(typeof window==='undefined'||!window.Pi)throw Error('WALLET_UNAVAILABLE')
 let timeout:ReturnType<typeof setTimeout>|undefined
 const authentication=window.Pi.authenticate(['username','payments','wallet_address'],
async (payment: any) => {
    // Handle incomplete payment from Pi Network
    
    // Only attempt completion if both piPaymentId and txid exist
    const piPaymentId = payment?.identifier
    const txid = payment?.transaction?.txid
    
    if (!piPaymentId || !txid) {
      CoreLogger.warn("Incomplete payment missing required fields during merchant auth", {
        hasIdentifier: !!piPaymentId,
        hasTransaction: !!payment?.transaction,
        hasTransactionId: !!txid,
      })
      return
    }
    
    try {
      const completeResponse = await fetch(`${config.appUrl}/api/pi/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ piPaymentId, txid }),
      })
      
      if (completeResponse.ok) {
        CoreLogger.info("Successfully completed incomplete payment during merchant auth", { piPaymentId, txid })
      } else {
        CoreLogger.warn("Failed to complete incomplete payment during merchant auth", { 
          status: completeResponse.status,
          piPaymentId,
          txid,
        })
      }
    } catch (error) {
      CoreLogger.error("Error completing incomplete payment during merchant auth", { error, piPaymentId, txid })
    }
  });
 return Promise.race([authentication,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('WALLET_UNAVAILABLE')),60000)})]).finally(()=>clearTimeout(timeout))
}
