/** Private read-only collector. Configuration arrives over stdin, never argv.
 * Output is explicitly unsigned and cannot be used as a certificate. */
import {collectR36InboundEvidence,type R36InboundExpected} from './r36-inbound-evidence-collector'

if(require.main===module){
 void(async()=>{
  const chunks:Buffer[]=[];let size=0
  for await(const data of process.stdin){const chunk=Buffer.from(data);size+=chunk.length;if(size>65536)throw Error('CONFIG_SIZE');chunks.push(chunk)}
  const c:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).sort().join(',')!=='expected,piApiKey')throw Error('CONFIG_FIELDS')
  const config=c as {expected:R36InboundExpected;piApiKey:string}
  const result=await collectR36InboundEvidence(config.expected,config.piApiKey)
  process.stdout.write(JSON.stringify(result)+'\n')
  if(result.outcome==='BLOCKED')process.exitCode=2
 })().catch(()=>{process.stderr.write('R36_INBOUND_COLLECTION_BLOCKED\n');process.exitCode=2})
}
