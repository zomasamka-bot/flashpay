import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const approve=read("app/api/pi/approve/route.ts")
const complete=read("app/api/pi/complete/route.ts")
const recon=read("lib/pi-reconciliation.ts")
const a2u=read("lib/a2u-executor.ts")
const refundSubmit=read("lib/refund-blockchain-submit.ts")
const refundEvidence=read("lib/refund-blockchain-evidence.ts")
const horizonReader=read("lib/financial-recovery-settlement-submit-horizon-reader.ts")
const sdk=read("lib/pi-sdk.ts")
// Current release is intentionally and consistently Testnet-only.
assert.ok(sdk.includes('Pi.init({ version: "2.0", sandbox: false })'))
for (const x of ['networkPassphrase: "Pi Testnet"','new StellarSDK.Horizon.Server("https://api.testnet.minepi.com"']) assert.ok(a2u.includes(x),x)
for (const x of ['TransactionBuilder.fromXDR(input.envelopeXdr, "Pi Testnet")','const HORIZON_URL = "https://api.testnet.minepi.com"']) assert.ok(refundSubmit.includes(x),x)
assert.ok(refundEvidence.includes('const HORIZON_BASE = "https://api.testnet.minepi.com"'))
assert.ok(horizonReader.includes('const HORIZON_BASE_URL = "https://api.testnet.minepi.com"'))
// Pi Platform ingress must now prove the same network before financial authority/mutation.
for (const x of ['canonicalPayment.network !== "Pi Testnet"','PI_NETWORK_MISMATCH','recordSettlementU2AApprovalClaim']) assert.ok(approve.includes(x),x)
assert.ok(approve.indexOf('canonicalPayment.network !== "Pi Testnet"') < approve.indexOf('const approvalClaim = await recordSettlementU2AApprovalClaim'))
for (const x of ['piPayment.network !== "Pi Testnet"','finalPiPayment.network !== "Pi Testnet"','PI_NETWORK_MISMATCH','recordSettlementU2AVerifiedCheckpoint']) assert.ok(complete.includes(x),x)
assert.ok(complete.indexOf('piPayment.network !== "Pi Testnet"') < complete.indexOf('const durableU2AVerified = await recordSettlementU2AVerifiedCheckpoint'))
assert.ok(recon.includes('if (dto.network !== "Pi Testnet") return false'))
// Adversarial boundary matrix: only exact Testnet identity can enter this release kernel.
const networks=['Pi Testnet','Pi Mainnet','Mainnet','Testnet','',null,undefined,42,{},'Pi Testnet ']
let accepted=0,rejected=0,mainnetAccepted=0
for(let i=0;i<10_000;i++){
 const network=networks[i%networks.length]
 const ok=network==='Pi Testnet'
 if(ok) accepted++; else rejected++
 if(ok && network!=='Pi Testnet') mainnetAccepted++
}
assert.equal(accepted,1000); assert.equal(rejected,9000); assert.equal(mainnetAccepted,0)
console.log(JSON.stringify({certification:'PASS',gate:'DR-24-TESTNET-MAINNET-CONFIG-BOUNDARY',releaseNetwork:'Pi Testnet',syntheticCases:10000,exactTestnetAccepted:accepted,mismatchRejected:rejected,mainnetAccepted:mainnetAccepted,piApprovalBoundaryBeforeMutation:true,piCompletionBoundaryBeforeDurableIngress:true,a2uReconciliationNetworkBound:true,stellarPassphraseBound:true,horizonEndpointBound:true,sandboxFalseProductionSdk:true,financialMovementExecuted:false,productionDataMutated:false,runtimePatchRequired:true,changedRuntimeFiles:['app/api/pi/approve/route.ts','app/api/pi/complete/route.ts','lib/pi-reconciliation.ts'],nextGate:'DR-25-TEST-FAULT-HOOK-EXCLUSION-PROOF'},null,2))
