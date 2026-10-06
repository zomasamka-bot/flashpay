import fs from 'node:fs'
const p='app/api/operations/fin4-step13-final-reconciliation/route.ts'
const s=fs.readFileSync(p,'utf8')
function ok(c,m){if(!c)throw new Error(`FIN4_STEP13_READ_ONLY_RECONCILIATION_FAIL: ${m}`)}
ok(s.includes('export async function GET'), 'GET surface missing')
ok(!/export async function (POST|PUT|PATCH|DELETE)/.test(s),'mutating HTTP handler present')
ok(!/method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/.test(s),'outbound mutating HTTP method present')
ok(!/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(s.replace(/console\.(warn|error)[\s\S]*?\n/g,'')),'DB mutation keyword present')
ok(s.includes('DB_PI_HORIZON_RECONCILED'),'final reconciliation verdict missing')
ok(s.includes('duplicateIdentities')&&s.includes('refundDuplicateIdentities')&&s.includes('merchantBalanceMismatches')&&s.includes('settlementRefundOverlap'),'global accounting/XOR checks missing')
ok(s.includes('PRESERVE_NO_ACTION')&&s.includes('NATURALLY_SETTLED')&&s.includes('R4J_RETIRED'),'A/B/C classifications missing')
ok(s.includes('piMutationExecuted:false')&&s.includes('horizonSubmitExecuted:false')&&s.includes('financialMutationExecuted:false'),'explicit no-mutation evidence missing')
ok(s.includes('https://api.minepi.com/v2/payments/')&&s.includes('https://api.testnet.minepi.com/transactions/'),'Pi/Horizon canonical reads missing')
ok(s.includes('cache:"no-store"'),'live no-store reads missing')
console.log('FIN4_STEP13_READ_ONLY_RECONCILIATION=PASS')
