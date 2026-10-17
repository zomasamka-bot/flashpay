/** R36: independent-evidence boundary consistency checks; never a trusted certificate.
 * Caller-supplied metadata is UNTRUSTED. This is a negative preflight only.
 */
import type {R36ReadResult} from './r36-horizon-history-reader'
export type R36BoundaryEvidence=Readonly<{
 walletId:string; network:string;
 accountCreationLedger:number; accountCreationTransactionHash:string;
 finalizedUpperLedger:number; finalizedUpperLedgerHash:string;
 ledgerProofSource:'independent_verified'|'caller_claim'|'unknown';
 accountProofSource:'independent_verified'|'caller_claim'|'unknown';
}>
export type R36BoundaryAudit=Readonly<{outcome:'BLOCKED';reason:string;authorizesRotation:false;observed:number}>
const deny=(reason:string,observed=0):R36BoundaryAudit=>({outcome:'BLOCKED',reason,authorizesRotation:false,observed})
const isHash=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)
const isWallet=(v:unknown):v is string=>typeof v==='string'&&/^G[A-Z2-7]{55}$/.test(v)
/** Reject inconsistent genesis/finality claims, but do not treat caller-set proofSource as verified.
 * Independent cryptographic provenance, account existence at genesis, full coverage,
 * cross-ledger fork consistency and Horizon server authenticity remain separate OPEN work.
 */
export function inspectR36HistoricalBoundaries(read:R36ReadResult,e:R36BoundaryEvidence):R36BoundaryAudit{
 if(!read||!e||!isWallet(e.walletId)||e.network!=='Pi Testnet'||!Number.isSafeInteger(e.accountCreationLedger)||e.accountCreationLedger<1||!Number.isSafeInteger(e.finalizedUpperLedger)||e.finalizedUpperLedger<e.accountCreationLedger||!isHash(e.accountCreationTransactionHash)||!isHash(e.finalizedUpperLedgerHash))return deny('INVALID_BOUNDARY_EVIDENCE')
 if(read.outcome!=='BLOCKED'||read.authorizesRotation!==false)return deny('UNTRUSTED_READER_RESULT')
 if(read.upperLedger!==e.finalizedUpperLedger)return deny('UPPER_LEDGER_MISMATCH')
 if(e.accountProofSource!=='independent_verified'||e.ledgerProofSource!=='independent_verified')return deny('INDEPENDENT_BOUNDARY_PROVENANCE_MISSING')
 if(!Array.isArray(read.pageEvidence)||read.pages!==read.pageEvidence.length||read.records!==read.pageEvidence.reduce((n,p)=>n+p.records.length,0))return deny('READER_EVIDENCE_INCONSISTENT')
 let seen=0
 for(const page of read.pageEvidence){
  if(!Array.isArray(page.records))return deny('INVALID_PAGE_EVIDENCE',seen)
  for(const raw of page.records){
   const row=raw as {ledger?:unknown;from?:unknown;to?:unknown;type?:unknown}
   if(!Number.isSafeInteger(row.ledger)||Number(row.ledger)<e.accountCreationLedger||Number(row.ledger)>e.finalizedUpperLedger)return deny('RECORD_OUTSIDE_BOUNDARIES',seen)
   seen++
  }
 }
 if(seen===0)return deny('GENESIS_AND_HISTORY_COVERAGE_UNPROVEN')
 // Even matching bounds + asserted provenance do not prove complete coverage or financial classification.
 return deny('HISTORY_COMPLETENESS_AND_ACCOUNTING_UNPROVEN',seen)
}
