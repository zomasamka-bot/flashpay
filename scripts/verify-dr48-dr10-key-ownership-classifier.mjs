import fs from 'node:fs'
const s=fs.readFileSync(new URL('../app/api/recovery/transient/route.ts', import.meta.url),'utf8')
const checks={
  exactKnownPrefix:s.includes('DR10_KNOWN_FLASH_PAY_FOREIGN_PREFIXES = ["pi:approval:"] as const'),
  allowlistUnchanged:s.includes('DR10_ALLOWED_REDIS_PREFIXES = ["flashpay:", "payment:", "receipt-file:"] as const'),
  countsKnown:s.includes('knownPiApprovalKeyCount+=1'),
  countsUnknown:s.includes('unknownForeignKeyCount+=1'),
  stillBlocksBeforeDelete:s.indexOf('if(foreignKeyCount>0)') < s.indexOf('let deleted=0'),
  noValuesRead:s.includes('valuesRead:false'),
  noRawKeys:s.includes('rawKeysLogged:false'),
  deletionFalse:s.includes('deletionAttempted:false'),
}
const pass=Object.values(checks).every(Boolean)
console.log(JSON.stringify({certification:pass?'PASS':'FAIL',gate:'DR48-DR10-KEY-OWNERSHIP-CLASSIFIER',...checks,financialMovementExecuted:false},null,2))
if(!pass) process.exit(1)
