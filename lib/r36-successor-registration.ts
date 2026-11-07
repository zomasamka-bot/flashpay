/** Production issuer completion. Register only a successor already named by an
 * independently enrolled prior approval; never issue that approval or rotate.
 * A crash between certificate and registration is retried by the SAME nonce.
 * Original certificate replay prevents a second signing request.
 */
import {runR36CertificateWorker, type R36WorkerPorts} from './r36-certificate-worker'
import type {R36CertificateDatabase, R36CertificateResult} from './r36-certificate-consumer'

export async function certifyR36ProductionAdmission(
  db:R36CertificateDatabase, nonce:string, ports:R36WorkerPorts,
):Promise<R36CertificateResult & {successorBinding?:'RECORDED'|'REPLAYED'|'NOT_REQUIRED'}> {
  const certificate=await runR36CertificateWorker(db,nonce,ports)
  if(certificate.outcome==='BLOCKED')return certificate
  try {
    return await db.begin(async tx=>{
      const rows=await tx.unsafe('SELECT public.r36_register_successor_binding($1) AS outcome',[nonce])
      const outcome=rows.length===1?rows[0].outcome:null
      if(outcome!=='RECORDED'&&outcome!=='REPLAYED'&&outcome!=='NOT_REQUIRED')
        throw Error('SUCCESSOR_APPROVAL_UNAVAILABLE')
      return {...certificate,successorBinding:outcome}
    })
  } catch {
    // Certificate may already be durable. Report the unresolved binding and keep
    // every financial authority flag false; a retry reuses that exact receipt.
    return {outcome:'BLOCKED',reason:'SUCCESSOR_APPROVAL_OR_REGISTRATION_UNAVAILABLE',
      certificateDigest:certificate.certificateDigest,
      authorizesFinancialRelease:false,authorizesRotation:false,authorizesWalletActivation:false}
  }
}
