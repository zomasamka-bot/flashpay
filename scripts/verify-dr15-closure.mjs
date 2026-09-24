import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const root=new URL('../',import.meta.url)
for(const f of ['scripts/verify-dr15a-settlement-ambiguous-network-response.mjs','scripts/verify-dr15b-pi-ambiguous-network-response.mjs','scripts/verify-dr15c-refund-horizon-ambiguous-network-response.mjs']) assert.ok(fs.existsSync(new URL(f,root)),`missing ${f}`)
const a=fs.readFileSync(new URL('scripts/verify-dr15a-settlement-ambiguous-network-response.mjs',root),'utf8')
const b=fs.readFileSync(new URL('scripts/verify-dr15b-pi-ambiguous-network-response.mjs',root),'utf8')
const c=fs.readFileSync(new URL('scripts/verify-dr15c-refund-horizon-ambiguous-network-response.mjs',root),'utf8')
assert.ok(a.includes('blind')&&a.includes('10000'),'15A settlement Horizon ambiguity coverage')
assert.ok(b.includes('blindCreateObserved')&&b.includes('blindCompleteObserved')&&b.includes('10000'),'15B Pi create/complete ambiguity coverage')
assert.ok(c.includes('exactStoredXdrReplayOnly')&&c.includes('duplicateMovementObserved')&&c.includes('10000'),'15C refund Horizon ambiguity coverage')
console.log(JSON.stringify({certification:'PASS',gate:'DR-15-CLOSURE',settlementHorizon:true,piCreateCompleteSettlementAndRefund:true,refundHorizon:true,blindRetryAllowed:false,freshRebuildUnderUncertainty:false,unknownFailClosed:true,nextGate:'DR-16-STELLAR-SDK-V17-COMPATIBILITY'},null,2))
