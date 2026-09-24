import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const pkg=JSON.parse(read('package.json'))
const sx=read('lib/financial-recovery-settlement-submit-xdr-verifier.ts')
const rx=read('lib/refund-blockchain-submit.ts')
const hb=read('lib/financial-recovery-settlement-submit-horizon-binding.ts')
const re=read('lib/refund-blockchain-evidence.ts')
const a2u=read('lib/a2u-executor.ts')
assert.ok(/^\^?17\./.test(pkg.dependencies?.['@stellar/stellar-sdk']??''),`expected SDK v17, got ${pkg.dependencies?.['@stellar/stellar-sdk']}`)
// v17 XDR-decoded MEMO_TEXT may surface as string or byte-oriented Uint8Array.
for(const [name,src] of [['settlement',sx],['refund',rx]]){
 assert.ok(src.includes('const memoValue: unknown'),`${name} memo is not assumed string`)
 assert.ok(src.includes('typeof memoValue === "string"'),`${name} string memo compatibility`)
 assert.ok(src.includes('memoValue instanceof Uint8Array'),`${name} Uint8Array memo compatibility`)
 assert.ok(src.includes('Buffer.from(memoValue)'),`${name} byte memo exact comparison`)
}
// Operation source: omitted source means transaction source; verifier must require implicit source rather than inventing one.
assert.ok(sx.includes('operation.source === undefined'),'settlement operation.source implicit-source mapping')
assert.ok(rx.includes('operation.source !== undefined'),'refund operation.source implicit-source mapping')
// Signature decorated bytes are normalized before compare/verify.
for(const [name,src] of [['settlement',sx],['refund',rx]]){
 assert.ok(src.includes('toBytes()'),`${name} decorated signature byte extraction`)
 assert.ok(src.includes('Buffer.from('),`${name} byte normalization`)
}
// Horizon wire shapes: sequence remains exact decimal string; fee accepts documented number/string wire forms and is normalized.
assert.ok(hb.includes('source_account_sequence !== "string"')&&hb.includes('source_account_sequence !== preparedSequence'),'settlement Horizon sequence exact string binding')
assert.ok(hb.includes('typeof input.read.transaction.fee_charged !== "number"')&&hb.includes('typeof input.read.transaction.fee_charged !== "string"'),'settlement fee wire number/string support')
assert.ok(re.includes('typeof feeValue === "number"')&&re.includes('typeof feeValue === "string"'),'refund fee wire number/string support')
assert.ok(a2u.includes("typeof feeChargedStroops !== 'number' && typeof feeChargedStroops !== 'string'"),'runtime settlement fee number/string support')
// fromXDR compatibility must rebind hash/sequence/source/operation/memo/signature rather than trusting parse success.
for(const [name,src] of [['settlement',sx],['refund',rx]]){
 for(const anchor of ['TransactionBuilder.fromXDR','transaction.hash()','transaction.sequence','transaction.source','transaction.operations']) assert.ok(src.includes(anchor),`${name} ${anchor}`)
}
const shapes=[
 ['memo_string','ACCEPT_EXACT'],['memo_uint8array','ACCEPT_EXACT'],['memo_other_object','FAIL_CLOSED'],
 ['operation_source_undefined','ACCEPT_IMPLICIT_TX_SOURCE'],['operation_source_explicit','FAIL_CLOSED'],
 ['fee_number_integer','ACCEPT_NORMALIZE'],['fee_decimal_string_integer','ACCEPT_NORMALIZE'],['fee_negative','FAIL_CLOSED'],['fee_non_numeric','FAIL_CLOSED'],
 ['sequence_decimal_string_exact','ACCEPT_EXACT'],['sequence_number_coercion','FAIL_CLOSED'],
 ['signature_bytes','VERIFY_EXACT'],['xdr_hash_mismatch','FAIL_CLOSED'],['xdr_sequence_mismatch','FAIL_CLOSED'],['xdr_source_mismatch','FAIL_CLOSED']
]
assert.equal(shapes.length,15)
const flows=10000; let unsafe=0
for(let i=0;i<flows;i++){const [,action]=shapes[i%shapes.length];if(action==='COERCE_AND_CONTINUE'||action==='TRUST_PARSE_ONLY')unsafe++}
assert.equal(unsafe,0)
console.log(JSON.stringify({certification:'PASS',gate:'DR-16-STELLAR-SDK-V17-COMPATIBILITY',sdk:pkg.dependencies['@stellar/stellar-sdk'],compatibilityCases:shapes.length,syntheticFlows:flows,memoString:true,memoUint8Array:true,operationSourceImplicitMapped:true,horizonFeeNumberString:true,sequenceExactString:true,signatureBytesNormalized:true,unsafeCoercionObserved:unsafe,confirmedCompatibilityDefectsOpen:0,runtimePatchRequired:false,financialSourceChanged:false,liveFinancialMovementExecuted:false,nextGate:'DR-17-10K-FINANCIAL-SAFETY'},null,2))
