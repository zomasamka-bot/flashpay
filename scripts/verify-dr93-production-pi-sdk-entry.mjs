import fs from 'node:fs'
const loader=fs.readFileSync('components/pi-sdk-loader.tsx','utf8')
const pay=fs.readFileSync('app/pay/[id]/payment-content-with-id.tsx','utf8')
const checks=[
 ['production Vercel Pi deep-link restored', pay.includes('target.protocol = "pi:"') && pay.includes('flashpay-two.vercel.app/pay/${encodeURIComponent(paymentId)}')],
 ['PiNet payment entry removed', !pay.includes('flashpayaefebeff3375.pinet.com/#/pay/')],
 ['signed bridge token retained', pay.includes('target.searchParams.set("bridge", data.token)')],
 ['entry=pi retained', pay.includes('target.searchParams.set("entry", "pi")')],
 ['loader owns Pi.init', loader.includes('await window.Pi.init({ version: "2.0", sandbox: false })')],
 ['readiness no longer resolves just because Pi exists', !loader.includes('window.__PI_SDK_READY__ = Promise.resolve()')],
 ['payment content no longer calls initializePiSDK', !pay.includes('initializePiSDK')],
 ['payment waits shared readiness', pay.includes('await window.__PI_SDK_READY__')],
 ['SDK initialized diagnostic present', pay.includes('Pi SDK initialized by loader - you can now pay')],
]
let fail=0
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)fail++}
if(fail)process.exit(1)
console.log(`DR93 production Pi SDK entry certifier PASS (${checks.length}/${checks.length})`)
