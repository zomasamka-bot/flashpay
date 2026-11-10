/** Private stdin-only job runner. No request route, admin session, secret output
 * or caller-supplied signed XDR. This process must have provider GET-only egress.
 * The downstream registrar revalidates the supplied policy against PostgreSQL.
 */
import postgres from 'postgres'
import {readR36PreparedSource} from './r36-prepared-evidence-reader'
import {readR36LiveSource} from './r36-live-source'
import {openR36Envelope} from './r36-prepared-evidence-seal'
import {collectR36LiveCandidate} from './r36-live-evidence-cli'
import {r36SnapshotDigest} from './r36-evidence-snapshot'
import {publishR36LiveEvidenceJob} from './r36-evidence-publication'
import {createR36RegistrarClient} from './r36-provider-transport'
const HOST='ep-falling-bonus-albeetu0.c-3.eu-central-1.aws.neon.tech'
if(require.main===module)void(async()=>{
 const chunks:Buffer[]=[];let size=0
 for await(const raw of process.stdin){const b=Buffer.from(raw);size+=b.length;if(size>50_000_000)throw Error('CONFIG_SIZE');chunks.push(b)}
 const c=JSON.parse(Buffer.concat(chunks).toString('utf8'));chunks.length=0
 if(!c||Object.keys(c).sort().join(',')!=='artifactDirectory,custodianPrivateKeyPem,custodyDecryptionKey,database,jobDirectory,piApiKey,policy,registrar,request')throw Error('CONFIG_FIELDS')
 const u=new URL(c.database)
 if(u.protocol!=='postgresql:'||u.hostname!==HOST||u.username!=='r36_evidence_reader'||u.pathname!=='/neondb'||u.search||u.hash||!u.password)throw Error('DATABASE_TARGET')
 if(!c.request||Object.hasOwn(c.request,'preparedEnvelopeXdr')||Object.hasOwn(c.request,'nonce'))throw Error('CALLER_PREPARED_IDENTITY_FORBIDDEN')
 const sql=postgres(c.database,{max:1,prepare:false,connect_timeout:8,ssl:{rejectUnauthorized:true,servername:HOST},onnotice:()=>{},connection:{application_name:'flashpay_r36_private_publication',default_transaction_read_only:true,statement_timeout:30000,lock_timeout:3000}})
 try{
  const {snapshot,candidate}=await readR36PreparedSource({beginReadOnly:async<T>(fn:Parameters<Parameters<typeof readR36LiveSource>[0]['beginReadOnly']>[0])=>sql.begin('isolation level repeatable read read only',async tx=>fn({unsafe:async s=>tx.unsafe(s)})) as Promise<T>},c.request.paymentId)
  if(candidate.identity.operationKind!==c.request.kind||candidate.identity.sourceWallet!==c.request.sourceWallet||candidate.encryptedEnvelope.recipientSpkiSha256!==c.policy?.workerProfile?.preparedEvidenceEncryption?.recipientSpkiSha256)throw Error('PUBLICATION_CANDIDATE_POLICY_CONFLICT')
  const register=createR36RegistrarClient(c.registrar)
  const result=await publishR36LiveEvidenceJob({candidateDigest:candidate.candidateDigest,sourceRowsDigest:r36SnapshotDigest(snapshot.rows),policy:c.policy,custodianPrivateKeyPem:c.custodianPrivateKeyPem,jobDirectory:c.jobDirectory,artifactDirectory:c.artifactDirectory},{
   collect:nonce=>collectR36LiveCandidate(snapshot,{...c.request,nonce,preparedEnvelopeXdr:openR36Envelope(candidate,c.custodyDecryptionKey)},c.piApiKey),
   register:binding=>register(binding,AbortSignal.timeout(135000))})
  // No raw evidence, XDR, tokens, private keys or provider response in logs.
  process.stdout.write(JSON.stringify(result)+'\n');if(result.outcome==='BLOCKED')process.exitCode=2
 }finally{await sql.end({timeout:3})}
})().catch(()=>{process.stderr.write('R36_PRIVATE_PUBLICATION_FAIL_CLOSED\n');process.exitCode=2})
