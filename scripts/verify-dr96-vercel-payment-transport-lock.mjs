import fs from 'node:fs'
import crypto from 'node:crypto'
const pay='app/pay/[id]/payment-content-with-id.tsx'
const loader='components/pi-sdk-loader.tsx'
const p=fs.readFileSync(pay,'utf8')
const l=fs.readFileSync(loader)
const gitBlob=(b)=>crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')
const checks={
  vercelPiDeepLink:p.includes('pi://flashpay-two.vercel.app/pay/${encodeURIComponent(paymentId)}'),
  noFlashpayPi:!p.includes('flashpay.pi'),
  noEntryToken:!p.includes('/api/pi/entry-token'),
  noBridgeGate:!p.includes('piEntryVerified')&&!p.includes('piEntryError'),
  authorityGuard:p.includes('if (authoritativeLoaded !== true || payment.status !== "pending") return'),
  noPaymentContentReinit:!p.includes('initializePiSDK'),
  waitsLoaderReadiness:p.includes('await window.__PI_SDK_READY__'),
  loaderExactDr92Blob:gitBlob(l)==='df678385dc6ffede5080584983a3a145ac8149f4'
}
const pass=Object.values(checks).every(Boolean)
console.log(JSON.stringify({certification:pass?'PASS':'FAIL',gate:'DR96-VERCEL-PAYMENT-TRANSPORT-LOCK',checks,loaderGitBlob:gitBlob(l)},null,2))
if(!pass) process.exit(1)
