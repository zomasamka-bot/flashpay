/** Production issuer completion. Register only a successor already named by an
 * independently enrolled prior approval; never issue that approval or rotate.
 * A crash between certificate and registration is retried by the SAME nonce.
 * Original certificate replay prevents a second signing request.
 */
import {createHash} from 'node:crypto'
import {R36_ADMISSION_FIELDS} from './r36-certificate-consumer'
import {runR36CertificateWorker, type R36WorkerPorts} from './r36-certificate-worker'
import type {R36CertificateDatabase, R36CertificateResult} from './r36-certificate-consumer'

export async function certifyR36ProductionAdmission(
  db:R36CertificateDatabase, nonce:string, ports:R36WorkerPorts,
):Promise<R36CertificateResult & {successorBinding?:'RECORDED'|'REPLAYED'|'NOT_REQUIRED'}> {
  const certificate=await runR36CertificateWorker(db,nonce,ports)
  if(certificate.outcome==='BLOCKED')return certificate
  try {
    return await db.begin(async tx=>{
      // Revalidation belongs to the SAME prepared owner. It must not invoke
      // bootstrap clearance or successor rotation for that existing owner.
      const current=await tx.unsafe('SELECT public.r36_certificate_context($1) AS context',[nonce])
      const ctx=current.length===1?current[0].context as {renewalGeneration?:unknown;renewalRequiresSuccessor?:unknown;receipt?:{manifest?:Record<string,string>}}|null:null
      if(ctx?.renewalGeneration!==undefined){
        const m=ctx.receipt?.manifest
        const fields=['schema','purpose','issuerId','keyId','policyDigest',...R36_ADMISSION_FIELDS,'issuedAt','expiresAt']
        if(!Number.isSafeInteger(ctx.renewalGeneration)||!m||fields.some(k=>typeof m[k]!=='string')||
          createHash('sha256').update('FLASHpay:R36:INITIAL_ADMISSION:V1\n'+JSON.stringify(fields.map(k=>m[k]))).digest('hex')!==certificate.certificateDigest)
          throw Error('RENEWAL_RECEIPT_CHANGED')
        if(ctx.renewalRequiresSuccessor===true){
          const rows=await tx.unsafe('SELECT public.r36_register_successor_binding($1) AS outcome',[nonce])
          const outcome=rows.length===1?rows[0].outcome:null
          if(outcome!=='RECORDED'&&outcome!=='REPLAYED')throw Error('SUCCESSOR_APPROVAL_UNAVAILABLE')
          return {...certificate,successorBinding:outcome as 'RECORDED'|'REPLAYED'}
        }
        return {...certificate,successorBinding:'NOT_REQUIRED' as const}
      }
      // The first certificate follows an explicitly owner-approved bootstrap.
      // SQL binds its exact clearance once; existing authority uses the original
      // successor path. This never enables a wallet or creates submission rights.
      const first=await tx.unsafe('SELECT public.r36_bind_initial_clearance($1) AS outcome',[nonce])
      if(first.length!==1||!['RECORDED','REPLAYED','NOT_REQUIRED'].includes(String(first[0].outcome)))
        throw Error('INITIAL_CLEARANCE_UNAVAILABLE')
      const rows=await tx.unsafe('SELECT public.r36_register_successor_binding($1) AS outcome',[nonce])
      const outcome=rows.length===1?rows[0].outcome:null
      if(outcome!=='RECORDED'&&outcome!=='REPLAYED'&&outcome!=='NOT_REQUIRED')
        throw Error('SUCCESSOR_APPROVAL_UNAVAILABLE')
      return {...certificate,successorBinding:outcome}
    })
  } catch {
    // Certificate may already be durable. Report the unresolved binding and keep
    // every financial authority flag false; a retry reuses that exact receipt.
    return {outcome:'BLOCKED',reason:'INITIAL_OR_SUCCESSOR_APPROVAL_UNAVAILABLE',
      certificateDigest:certificate.certificateDigest,
      authorizesFinancialRelease:false,authorizesRotation:false,authorizesWalletActivation:false}
  }
}
