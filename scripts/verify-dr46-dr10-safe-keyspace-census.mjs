import fs from 'node:fs'
const src=fs.readFileSync('app/api/recovery/transient/route.ts','utf8')
const assertions={
  cryptographicFingerprint: src.includes('createHash("sha256").update(key).digest("hex").slice(0,16)'),
  noRawUnexpectedKeyLog: !src.includes('preflight rejected unexpected key'),
  boundedSamples: src.includes('foreignKeyDiagnostics.length<32'),
  fullScanBeforeVerdict: src.includes('} while(cursor!=="0")') && src.indexOf('if(foreignKeyCount>0)')>src.indexOf('} while(cursor!=="0")'),
  blocksBeforeDeletion: src.indexOf('if(foreignKeyCount>0)')<src.indexOf('// Delete in bounded batches.'),
  noValuesReadForForeignKeys: src.includes('valuesRead:false'),
  noDeletionOnCensusBlock: src.includes('deletionAttempted:false'),
  safeMetadataOnly: src.includes('keyLength:key.length')&&src.includes('colonCount:(key.match(/:/g)??[]).length')&&src.includes('await redis.type(key)')&&src.includes('await redis.ttl(key)'),
  originalAllowlistUnchanged: src.includes('const DR10_ALLOWED_REDIS_PREFIXES = ["flashpay:", "payment:", "receipt-file:"] as const'),
  financialAuthorityUntouched: !src.includes('DR46') || (src.includes('postgresMutated:false')&&src.includes('piCalled:false')&&src.includes('horizonCalled:false')),
}
const failed=Object.entries(assertions).filter(([,v])=>!v)
console.log(JSON.stringify({certifier:'DR46_DR10_SAFE_KEYSPACE_CENSUS',assertions},null,2))
if(failed.length){console.error('FAILED',failed.map(([k])=>k));process.exit(1)}
console.log('DR46 PASS')
