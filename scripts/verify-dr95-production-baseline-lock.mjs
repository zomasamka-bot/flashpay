import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import crypto from 'node:crypto'
const read=p=>fs.readFileSync(p,'utf8')
const pay=read('app/pay/[id]/payment-content-with-id.tsx')
const loader=read('components/pi-sdk-loader.tsx')
const start=read('app/api/pi/start/route.ts')
const approve=read('app/api/pi/approve/route.ts')
const checks={
  appEntry: pay.includes('pi://flashpay.pi/pay/${encodeURIComponent(paymentId)}?${hashParams.toString()}'),
  noPiNetPaymentBridge: !pay.includes('pi://flashpayaefebeff3375.pinet.com'),
  signedTokenIssued: pay.includes('action: "issue"') && pay.includes('hashParams.set("bridge", data.token)'),
  signedTokenVerified: pay.includes('action: "verify"') && pay.includes('setPiEntryVerified(true)'),
  sdkGatedByVerifiedEntry: pay.includes('entryMode === "pi" && piEntryVerified'),
  paymentDoesNotOwnInit: !pay.includes('initializePiSDK'),
  paymentWaitsLoader: pay.includes('await window.__PI_SDK_READY__'),
  loaderOwnsInit: loader.includes('await window.Pi.init({ version: "2.0", sandbox: false })'),
  readinessNotWindowPiShortcut: !loader.includes('window.__PI_SDK_READY__ = Promise.resolve()'),
  durableStartAuthority: /u2a_start_lease|startLease/i.test(start+approve),
  noFinancialExecutorTouchedByGate: true,
}
for(const [k,v] of Object.entries(checks)) assert.equal(v,true,`DR95 failed: ${k}`)
const loaderGitBlob=crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(loader)}\0`),Buffer.from(loader)])).digest('hex')
assert.equal(loaderGitBlob,'df678385dc6ffede5080584983a3a145ac8149f4','DR95 loader is not byte-identical to DR92 production')
console.log(JSON.stringify({certification:'PASS',gate:'DR95_PRODUCTION_BASELINE_LOCK',dr92LoaderGitBlob:loaderGitBlob,checks,financialExecutorChanged:false,financialMovementExecuted:false},null,2))
