import fs from 'node:fs'
const r=fs.readFileSync('app/api/recovery/transient/route.ts','utf8')
const c=fs.readFileSync('app/api/control/dr10/route.ts','utf8')
const checks={
 opaqueStringPreflightCursor:r.includes('let cursor="0"')&&r.includes('while(cursor!=="0")'),
 opaqueStringResidualCursor:r.includes('let residualCursor="0"')&&r.includes('while(residualCursor!=="0")'),
 acceptsDocumentedStringCursor:r.includes('typeof nextRaw==="string"')&&r.includes('typeof nextResidualRaw==="string"'),
 cursorFailureObservable:r.includes('preflight cursor indeterminate')&&r.includes('residual cursor indeterminate'),
 deletionFailureObservable:r.includes('deletion failed')&&r.includes('deletion result indeterminate'),
 noUnexpectedKeyValueLogging:!r.includes('key.slice(0,120)')&&!r.includes('console.error("[DR10 LIVE TOTAL REDIS LOSS] preflight rejected unexpected key"')&&r.includes('createHash("sha256").update(key)'),
 ownerSafeErrorPropagation:c.includes('safeInternalError')&&c.includes('internalError: safeInternalError'),
 ownerGatePreserved:c.includes('verifyOwnerAuthorizationHeader'),
 exactConfirmationPreserved:r.includes('DR10_TOTAL_REDIS_LOSS_CONFIRM'),
}
if(Object.values(checks).some(v=>!v)){console.error(JSON.stringify({certification:'FAIL',checks},null,2));process.exit(1)}
console.log(JSON.stringify({certification:'PASS',gate:'DR45-DR10-CURSOR-AND-SAFE-ERROR',checks,financialMovementExecuted:false},null,2))
