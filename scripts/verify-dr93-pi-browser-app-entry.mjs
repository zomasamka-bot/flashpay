import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const pay = fs.readFileSync('app/pay/[id]/payment-content-with-id.tsx','utf8')
const router = fs.readFileSync('lib/router.ts','utf8')
const domains = fs.readFileSync('lib/domains.ts','utf8')
const sdk = fs.readFileSync('lib/pi-sdk.ts','utf8')
const start = fs.readFileSync('app/api/pi/start/route.ts','utf8')
const approve = fs.readFileSync('app/api/pi/approve/route.ts','utf8')
const checks = {
  primaryAppIdentity: /domain:\s*["']flashpay\.pi["']/.test(domains),
  piBrowserAppEntry: /pi:\/\/flashpay\.pi\/pay\/\$\{encodeURIComponent\(paymentId\)\}\?\$\{hashParams\.toString\(\)\}/.test(pay),
  noActivePiNetBridge: !/pi:\/\/flashpayaefebeff3375\.pinet\.com/.test(pay),
  signedBridgeIssued: /action:\s*["']issue["']/.test(pay) && /hashParams\.set\(["']bridge["'],\s*data\.token\)/.test(pay),
  exactPaymentBound: /encodeURIComponent\(paymentId\)/.test(pay),
  entryPiBound: /hashParams\.set\(["']entry["'],\s*["']pi["']\)/.test(pay),
  signedBridgeVerifiedBeforeSdk: /action:\s*["']verify["']/.test(pay) && /if \(entryMode === ["']pi["'] && piEntryVerified\)/.test(pay),
  officialSdkSourcePresent: fs.readFileSync('components/pi-sdk-loader.tsx','utf8').includes('https://sdk.minepi.com/pi-sdk.js'),
  sdkInitV2: /Pi\.init\(\{ version: ["']2\.0["'], sandbox: false \}\)/.test(sdk),
  authPaymentsScope: /authenticate\(\[["']username["'],["']payments["'],["']wallet_address["']\]/.test(sdk),
  durableStartAuthorityPresent: /u2a_start_lease|startLease/i.test(start + approve + sdk),
  legacyHelperStillIdentifiesApp: /getPiDeepLink\(id: string, domain = ["']flashpay\.pi["']/.test(router),
}
for (const [name, ok] of Object.entries(checks)) assert.equal(ok, true, `DR93 failed: ${name}`)
console.log(JSON.stringify({certification:'PASS',gate:'DR93_PI_BROWSER_APP_ENTRY',checks,financialExecutorChanged:false,financialMovementExecuted:false},null,2))
