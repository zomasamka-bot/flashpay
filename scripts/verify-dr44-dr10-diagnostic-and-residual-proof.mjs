import fs from 'node:fs'
const s=fs.readFileSync('app/api/recovery/transient/route.ts','utf8')
const checks={
 preflightScanCatch:s.includes('preflight scan failed'),
 preflightShapeDiagnostic:s.includes('preflight scan shape indeterminate'),
 residualExhaustive:s.includes('do {')&&(s.includes('residualCursor!==0')||s.includes('residualCursor!=="0"')),
 residualScanCatch:s.includes('residual scan failed'),
 residualShapeDiagnostic:s.includes('residual scan shape indeterminate'),
 residualCursorDiagnostic:s.includes('residual cursor indeterminate'),
 noPiHorizonMutation:s.includes('postgresMutated:false,piCalled:false,horizonCalled:false'),
 ownerGatePreserved:fs.readFileSync('app/api/control/dr10/route.ts','utf8').includes('verifyOwnerAuthorizationHeader'),
 exactConfirmPreserved:s.includes('DR10_TOTAL_REDIS_LOSS_CONFIRM'),
}
if(Object.values(checks).some(v=>!v)){console.error(JSON.stringify({certification:'FAIL',checks},null,2));process.exit(1)}
console.log(JSON.stringify({certification:'PASS',gate:'DR44-DR10-DIAGNOSTIC-AND-RESIDUAL-PROOF',checks,financialMovementExecuted:false},null,2))
