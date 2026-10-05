import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert'
const root=join(__dirname,'..')
const base={route:readFileSync(join(root,'app/api/pi/recover-pretransaction/route.ts'),'utf8'),db:readFileSync(join(root,'lib/db.ts'),'utf8'),sdk:readFileSync(join(root,'lib/pi-sdk.ts'),'utf8')}
function passes(x=base){return [
 x.route.includes("https://api.minepi.com/v2/me"), x.route.includes("before.pi.user_uid!==uid"), x.route.includes("pi.transaction==null"),
 x.route.includes("pi.status?.transaction_verified===false"), x.route.includes("pi.status?.developer_completed===false"), x.route.includes("https://api.testnet.minepi.com/accounts/"), x.route.includes("tx?.memo===piPaymentId"), x.route.includes("const horizonBefore=await proveHorizonAbsence"), x.route.includes("const horizonAfter=await proveHorizonAbsence"),
 x.route.indexOf("const after=await getPi")>x.route.indexOf("/cancel"),
 x.route.lastIndexOf("retireSettlementU2AApprovalAfterCanonicalCancellation")>x.route.indexOf("const after=await getPi"),
 x.db.includes("pg_advisory_xact_lock(hashtextextended(${params.paymentId}, 0))"), x.db.includes("settlement_u2a_approval_retirements"),
 x.db.includes("u2a_identifier IS NULL AND u2a_txid IS NULL"), x.db.includes("a2u_payment_id IS NULL AND prepared_tx_hash IS NULL AND a2u_txid IS NULL AND horizon_confirmed_at IS NULL"),
 x.sdk.includes("onError: async (error: Error, piPayment?: any)"), x.sdk.includes("metadataPaymentId === paymentId")
].every(Boolean)}
assert(passes())
const muts:[keyof typeof base,string,string][]=[
 ['route','https://api.minepi.com/v2/me','https://invalid.local/me'],['route','before.pi.user_uid!==uid','false'],['route','pi.transaction==null','true'],
 ['route','pi.status?.transaction_verified===false','true'],['route','pi.status?.developer_completed===false','true'],['route','https://api.testnet.minepi.com/accounts/','https://invalid.local/accounts/'],['route','tx?.memo===piPaymentId','false'],['route','const horizonBefore=await proveHorizonAbsence',"const horizonBefore={outcome:'ABSENT'} as any //"],['route','const horizonAfter=await proveHorizonAbsence',"const horizonAfter={outcome:'ABSENT'} as any //"],['route','const after=await getPi','const after={ok:true,pi:before.pi} as any //'],
 ['route','const retired=await retireSettlementU2AApprovalAfterCanonicalCancellation({paymentId,piPaymentId,piCancelledAt:new Date().toISOString()})',"const retired={outcome:'RETIRED',version:1} as any"],
 ['db','pg_advisory_xact_lock(hashtextextended(${params.paymentId}, 0))','1'],['db','settlement_u2a_approval_retirements','settlement_u2a_retirements_REMOVED'],
 ['db','u2a_identifier IS NULL AND u2a_txid IS NULL','TRUE'],['db','a2u_payment_id IS NULL AND prepared_tx_hash IS NULL AND a2u_txid IS NULL AND horizon_confirmed_at IS NULL','TRUE'],
 ['sdk','onError: async (error: Error, piPayment?: any)','onError: async (error: Error)'],['sdk','metadataPaymentId === paymentId','true']]
let caught=0
for(const [k,a,b] of muts){const m={...base,[k]:base[k].split(a).join(b)}; const c=!passes(m); if(c)caught++}
assert.equal(caught,muts.length)
console.log(`R4J_U2A_PRETRANSACTION_MUTATIONS=PASS expected_failures=${muts.length} unexpected_passes=0`)
