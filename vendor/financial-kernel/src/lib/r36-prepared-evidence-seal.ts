/** Confidentiality boundary for a pre-admission signed envelope. Database readers
 * receive only its unsigned body and authenticated ciphertext, never a spendable
 * envelope. This encryption key is separate from all financial signing keys. */
import {createHash,createPublicKey,createPrivateKey,randomBytes,publicEncrypt,privateDecrypt,createCipheriv,createDecipheriv,constants} from 'node:crypto'
import {Transaction,TransactionBuilder,Keypair} from '@stellar/stellar-sdk'
export type R36EnvelopeSeal={schema:'R36_ENVELOPE_SEALED_V1';recipientSpkiSha256:string;wrappedKey:string;iv:string;tag:string;ciphertext:string}
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
export function unsignedR36Envelope(t:Transaction):string{
 const copy=TransactionBuilder.fromXDR(t.toXDR(),'Pi Testnet');if(!(copy instanceof Transaction))throw Error('SEALED_TRANSACTION_TYPE')
 copy.signatures.splice(0,copy.signatures.length);return copy.toXDR()
}
function context(unsigned:string,signedHash:string):Buffer{return Buffer.from('FLASHpay:R36:SEALED_PREPARED:V1\n'+sha(unsigned)+'\n'+signedHash)}
export function sealR36Envelope(t:Transaction,publicKeyPem:string):{envelopeXdr:string;signedEnvelopeSha256:string;encryptedEnvelope:R36EnvelopeSeal}{
 const k=createPublicKey(publicKeyPem);if(k.asymmetricKeyType!=='rsa'||(k.asymmetricKeyDetails?.modulusLength??0)<3072)throw Error('EVIDENCE_RECIPIENT_KEY')
 const text=t.toXDR(),envelopeXdr=unsignedR36Envelope(t),signedEnvelopeSha256=sha(text),key=randomBytes(32),iv=randomBytes(12)
 try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(context(envelopeXdr,signedEnvelopeSha256));const ciphertext=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
 return{envelopeXdr,signedEnvelopeSha256,encryptedEnvelope:{schema:'R36_ENVELOPE_SEALED_V1',recipientSpkiSha256:sha(k.export({type:'spki',format:'der'})),wrappedKey:publicEncrypt({key:k,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}}
 }finally{key.fill(0)}
}
export function verifyR36SignedEnvelope(t:Transaction,unsigned:string,signedHash:string){
 if(unsignedR36Envelope(t)!==unsigned||sha(t.toXDR())!==signedHash||t.signatures.length!==1)throw Error('SEALED_ENVELOPE_BINDING')
 const k=Keypair.fromPublicKey(t.source),sig=t.signatures[0]
 if(!Buffer.from(sig.hint.toBytes()).equals(Buffer.from(k.signatureHint()))||!k.verify(t.hash(),sig.signature.toBytes()))throw Error('SEALED_ENVELOPE_SIGNATURE')
}
export function openR36Envelope(c:{envelopeXdr:string;signedEnvelopeSha256:string;encryptedEnvelope:R36EnvelopeSeal},privateKeyPem:string):string{
 const e=c.encryptedEnvelope,k=createPrivateKey(privateKeyPem)
 if(!e||Object.keys(e).sort().join(',')!=='ciphertext,iv,recipientSpkiSha256,schema,tag,wrappedKey'||e.schema!=='R36_ENVELOPE_SEALED_V1'||k.asymmetricKeyType!=='rsa'||
  (k.asymmetricKeyDetails?.modulusLength??0)<3072||sha(createPublicKey(k).export({type:'spki',format:'der'}))!==e.recipientSpkiSha256)throw Error('SEALED_RECIPIENT')
 const decode=(v:string,max:number)=>{if(typeof v!=='string'||v.length>max||!v.length)throw Error('SEALED_ENCODING');const b=Buffer.from(v,'base64');if(b.toString('base64')!==v)throw Error('SEALED_ENCODING');return b}
 const iv=decode(e.iv,24),tag=decode(e.tag,24),wrapped=decode(e.wrappedKey,1400),ciphertext=decode(e.ciphertext,48000)
 if(iv.length!==12||tag.length!==16)throw Error('SEALED_LENGTH')
 const key=privateDecrypt({key:k,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},wrapped)
 try{if(key.length!==32)throw Error('SEALED_KEY_LENGTH');const dec=createDecipheriv('aes-256-gcm',key,iv);dec.setAAD(context(c.envelopeXdr,c.signedEnvelopeSha256));dec.setAuthTag(tag);const text=Buffer.concat([dec.update(ciphertext),dec.final()]).toString('utf8');
 const t=TransactionBuilder.fromXDR(text,'Pi Testnet');if(!(t instanceof Transaction))throw Error('SEALED_TRANSACTION_TYPE');verifyR36SignedEnvelope(t,c.envelopeXdr,c.signedEnvelopeSha256);return text
 }finally{key.fill(0)}
}
