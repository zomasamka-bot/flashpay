/** NOT_FOR_DEPLOY. Run under independently controlled signer identity/custody only.
 * Exact approval must already exist in its protected signing database. It cannot
 * approve its own requests or touch financial tables. Commit precedes acknowledgement.
 */
import {createHash,createPublicKey,sign,verify,type KeyObject} from 'node:crypto'
import type {R36CertificateDatabase} from './r36-certificate-consumer'
export type R36SignRequest={issuerId:string;keyId:string;policyDigest:string;idempotencyKey:string;bytesBase64:string}
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
export async function signR36ApprovedOnce(db:R36CertificateDatabase,key:KeyObject,request:R36SignRequest){
 const q={...request};if(Object.keys(q).sort().join(',')!=='bytesBase64,idempotencyKey,issuerId,keyId,policyDigest'||![q.issuerId,q.keyId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v))||![q.policyDigest,q.idempotencyKey].every(v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v))||typeof q.bytesBase64!=='string'||q.bytesBase64.length>32768||key.type!=='private'||key.asymmetricKeyType!=='ed25519')throw Error('SIGNING_INPUT_INVALID')
 const bytes=Buffer.from(q.bytesBase64,'base64');if(bytes.toString('base64')!==q.bytesBase64||hash(bytes)!==q.idempotencyKey)throw Error('SIGNING_PAYLOAD_MISMATCH')
 const pub=createPublicKey(key),pin=hash(pub.export({type:'spki',format:'der'}))
 const signature=await db.begin(async tx=>{
  const rows=await tx.unsafe('SELECT r36_signing.context($1) AS context',[q.idempotencyKey]);const c=rows.length===1?rows[0].context as Record<string,unknown>:null
  if(!c||c.issuer_id!==q.issuerId||c.key_id!==q.keyId||c.policy_digest!==q.policyDigest||c.bytes_base64!==q.bytesBase64||c.public_key_pin!==pin)throw Error('SIGNING_REQUEST_NOT_APPROVED')
  const signature=typeof c.signature==='string'?c.signature:sign(null,bytes,key).toString('base64')
  const raw=Buffer.from(signature,'base64');if(raw.length!==64||raw.toString('base64')!==signature||!verify(null,bytes,pub,raw))throw Error('SIGNING_RECEIPT_INVALID')
  const result=await tx.unsafe('SELECT r36_signing.record($1,$2) AS signature',[q.idempotencyKey,signature]);if(result.length!==1||result[0].signature!==signature)throw Error('SIGNING_COMMIT_DENIED');return signature
 })
 return{signature,payloadDigest:q.idempotencyKey,keyId:q.keyId,idempotencyKey:q.idempotencyKey}
}
