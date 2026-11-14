import 'server-only'
import { financialNetwork, financialHorizonOrigin, financialIncomingWallet } from './financial-network'
import { serverConfig } from './server-config'
import { query, readSettlementU2APretransactionRecoveryCandidate, retireSettlementU2AApprovalAfterCanonicalCancellation } from './db'

/** An existing canonical cancellation can retire only its exact unspent approval.
 * Never sends /cancel, /approve, /complete or a blockchain transaction. This does
 * not release the ingress reservation: the same request and original guards remain.
 */
export async function retireCancelledPaymentStart(paymentId: string, payerUid: string): Promise<boolean> {
  const policy = process.env.R36_SCOPED_POLICY_DIGEST
  if (!serverConfig.isPiApiKeyConfigured || !policy || !/^[0-9a-f]{64}$/.test(policy)) return false
  try {
    const rows = await query(`SELECT c.u2a_approval_identifier AS identifier
      FROM public.settlement_checkpoints c
      JOIN public.r36_payment_intake i ON i.payment_id=c.payment_id
      JOIN public.r36_testnet_ingress_reservations r ON r.payment_id=i.payment_id AND r.policy_digest=i.policy_digest
      JOIN public.r36_certificate_policies p ON p.policy_digest=i.policy_digest
      JOIN public.financial_wallet_activation w ON w.source_wallet=i.source_wallet AND w.network=public.r36_network()
      WHERE c.payment_id=$1 AND i.payer_uid=$2 AND i.policy_digest=$3
       AND r.retired_by_payment_id IS NULL AND w.state='enabled'
       AND public.r36_policy_wallet(p.worker_profile)=i.source_wallet
       AND p.enabled AND NOT p.revoked
       AND extract(epoch FROM clock_timestamp()) BETWEEN p.valid_from AND least(p.valid_until,p.revocation_valid_until)-1
       AND c.stage='payment_identity' AND c.u2a_approval_identifier IS NOT NULL
       AND c.u2a_approval_claimed_at IS NOT NULL LIMIT 2`, [paymentId,payerUid,policy])
    const identifier = Array.isArray(rows) && rows.length === 1 ? (rows[0] as {identifier?:unknown}).identifier : null
    if (typeof identifier !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(identifier)) return false
    const candidate = await readSettlementU2APretransactionRecoveryCandidate(paymentId,identifier)
    if (candidate.outcome !== 'CANDIDATE') return false
    const readPi = async () => {
      const r = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(identifier)}`, {
        headers:{Authorization:`Key ${serverConfig.piApiKey}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000),
      })
      return r.ok ? await r.json() : null
    }
    const exact = (p:any):boolean => Boolean(p && p.identifier===identifier && p.metadata?.paymentId===paymentId &&
      p.user_uid===payerUid && p.amount===candidate.customerAmount && p.network===financialNetwork() &&
      p.direction==='user_to_app' && p.to_address===financialIncomingWallet() &&
      typeof p.from_address==='string' && (p.from_address==='' || /^G[A-Z2-7]{55}$/.test(p.from_address)) &&
      p.status?.developer_approved===true && p.status?.transaction_verified===false && p.status?.developer_completed===false &&
      typeof p.status?.cancelled==='boolean' && typeof p.status?.user_cancelled==='boolean' &&
      (p.status.cancelled===true || p.status.user_cancelled===true) && p.transaction===null &&
      typeof p.created_at==='string' && Number.isFinite(Date.parse(p.created_at)) && Date.parse(p.created_at)<=Date.now())
    const before = await readPi()
    if (!exact(before)) return false
    // The sender address may be empty before wallet signing. Check the canonical
    // application recipient instead: any U2A credit must appear on this account.
    // Missing pages, 404, timeouts and exhausted bounds never establish absence.
    const absent = async ():Promise<boolean> => {
      const origin=financialHorizonOrigin(), account=financialIncomingWallet()
      const path=`/accounts/${account}/transactions`
      let url=`${origin}${path}?order=desc&limit=200&include_failed=true`
      const seen=new Set<string>();let last=Infinity
      for(let page=0;page<20;page++) {
        if(seen.has(url))return false;seen.add(url)
        const response=await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})
        if(!response.ok)return false
        const body=await response.json(), records=body?._embedded?.records
        if(!Array.isArray(records))return false
        for(const tx of records) {
          const time=typeof tx?.created_at==='string'?Date.parse(tx.created_at):NaN
          if(!Number.isFinite(time)||time>last||typeof tx.successful!=='boolean')return false
          last=time
          if(tx.memo_type==='text'&&tx.memo===identifier)return false
        }
        if(records.length===0 || last<=Date.parse(before.created_at)-300000)return true
        if(typeof body?._links?.next?.href!=='string')return false
        const next=new URL(body._links.next.href)
        if(next.origin!==origin||next.pathname!==path||next.searchParams.get('order')!=='desc'||next.searchParams.get('include_failed')!=='true')return false
        url=next.href
      }
      return false
    }
    if (!await absent()) return false
    const after=await readPi()
    if (!exact(after) || after.created_at!==before.created_at || after.from_address!==before.from_address || !await absent()) return false
    // The existing locked compare-and-swap refuses every progressed or changed
    // approval and keeps the immutable retirement record. No new reset mechanism.
    const retired=await retireSettlementU2AApprovalAfterCanonicalCancellation({paymentId,piPaymentId:identifier,piCancelledAt:new Date().toISOString()})
    if(retired.outcome!=='RETIRED'&&retired.outcome!=='REPLAYED')return false
    console.info('[Payment start recovery]',{outcome:'CANONICAL_CANCELLED_APPROVAL_RETIRED'})
    return true
  } catch { return false }
}
