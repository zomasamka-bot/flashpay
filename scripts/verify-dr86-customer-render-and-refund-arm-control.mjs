import fs from 'node:fs'
const page=fs.readFileSync('app/page.tsx','utf8')
const customer=fs.readFileSync('components/customer-payment-view.tsx','utf8')
const route=fs.readFileSync('app/api/control/dr14/route.ts','utf8')
const checks={
  armUiSettlementFailed: page.includes('payment?.status === "settlement_failed"'),
  armHandlerSettlementFailed: page.includes('payment?.status !== "settlement_failed"'),
  readinessBeforeArm: page.indexOf('READINESS_DR14_ONLY') < page.indexOf('ARM_DR14_ONE_SHOT'),
  readbackBeforeStart: page.indexOf('DR14 armed readback proof failed') < page.indexOf('START_DR14_REFUND_ONCE'),
  startServerConfirmation: route.includes('START_DR14_REFUND_ONCE'),
  customerSdkBounded: customer.includes('Promise.race([') && customer.includes('Pi SDK initialization timed out'),
  customerSdkErrorVisible: customer.includes('role="alert"') && customer.includes('Pi Network connection failed') && customer.includes('{authError}'),
  customerPaymentFetchPreserved: customer.includes('getPaymentFromServer(paymentId, true)'),
  customerPayPendingOnly: customer.includes('if (payment.status !== "pending") return'),
}
for(const [k,v] of Object.entries(checks)) if(!v) throw new Error(`DR86 gate failed: ${k}`)
console.log(JSON.stringify({certification:'PASS',gate:'DR86-CUSTOMER-RENDER-AND-REFUND-ARM-CONTROL',...checks},null,2))
