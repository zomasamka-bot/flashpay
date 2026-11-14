/** Lossless evidence transport only. Authenticate the signed text BEFORE decoding.
 * The full original body still passes the existing financial snapshot reviewer.
 * No cached verdict, omitted history, checkpoint, or authority is introduced. */
import {createHash} from 'node:crypto'
import {gzipSync,gunzipSync} from 'node:zlib'
const SCHEMA='R36_LOSSLESS_ARTIFACT_GZIP_V1'
export const R36_ARTIFACT_TEXT_BYTES=8_000_000
export const R36_ARTIFACT_ENVELOPE_BYTES=8_100_000
const PLAIN_LIMIT=2_000_000, RAW_LIMIT=64_000_000, COMPRESSED_LIMIT=5_999_000
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
function must(v:unknown):asserts v{if(!v)throw Error('ARTIFACT_ENCODING_INVALID')}
export function encodeR36Artifact(body:Record<string,unknown>):string{
 must(object(body)&&body.schema!==SCHEMA)
 const text=JSON.stringify(body),raw=Buffer.from(text,'utf8');must(raw.length<=RAW_LIMIT)
 if(raw.length<=1_000_000)return text
 const data=gzipSync(raw,{level:6});must(data.length<=COMPRESSED_LIMIT)
 const encoded=JSON.stringify({schema:SCHEMA,bytes:raw.length,sha256:sha(raw),data:data.toString('base64')})
 must(Buffer.byteLength(encoded)<=R36_ARTIFACT_TEXT_BYTES);return encoded
}
export function decodeR36Artifact(text:string):Record<string,unknown>{
 must(typeof text==='string'&&Buffer.byteLength(text)<=R36_ARTIFACT_TEXT_BYTES)
 const envelope:unknown=JSON.parse(text);must(object(envelope))
 if(envelope.schema!==SCHEMA){must(Buffer.byteLength(text)<=PLAIN_LIMIT);return envelope}
 must(Object.keys(envelope).sort().join(',')==='bytes,data,schema,sha256'&&Number.isSafeInteger(envelope.bytes)&&
  Number(envelope.bytes)>0&&Number(envelope.bytes)<=RAW_LIMIT&&typeof envelope.sha256==='string'&&/^[0-9a-f]{64}$/.test(envelope.sha256)&&typeof envelope.data==='string')
 const data=Buffer.from(envelope.data,'base64');must(data.length>0&&data.length<=COMPRESSED_LIMIT&&data.toString('base64')===envelope.data)
 // Bound allocation even when a correctly signed source supplies a gzip bomb.
 const raw=gunzipSync(data,{maxOutputLength:Number(envelope.bytes)})
 must(raw.length===envelope.bytes&&sha(raw)===envelope.sha256)
 const utf8=raw.toString('utf8');must(Buffer.from(utf8).equals(raw))
 const body:unknown=JSON.parse(utf8);must(object(body)&&body.schema!==SCHEMA);return body
}
