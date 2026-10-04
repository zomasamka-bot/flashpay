import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isTerminalNoMovementProjectionCandidate } from '../lib/operational-terminal-prune-rules'
import type { Payment } from '../lib/types'

const must = (ok: boolean, msg: string) => { if (!ok) throw new Error(`EMERGENCY_RESCUE_SAFETY=FAIL ${msg}`) }
const now = new Date(0).toISOString()
const base: Payment = { id:'p-safe-0001', merchantId:'m', amount:1, customerAmount:1, note:'', status:'failed', createdAt:now }
let cases = 0
const yes = (p: Payment, msg: string) => { cases++; must(isTerminalNoMovementProjectionCandidate(p), msg) }
const no = (p: Payment, msg: string) => { cases++; must(!isTerminalNoMovementProjectionCandidate(p), msg) }
yes(base, 'clean failed terminal must remain prune candidate')
yes({...base,status:'cancelled'}, 'clean cancelled terminal must remain prune candidate')
no({...base,status:'paid_to_app'}, 'nonterminal paid_to_app must block')
no({...base,paidAt:now}, 'paidAt must block')
no({...base,u2aTxid:'u2a'}, 'U2A txid must block')
no({...base,a2uPaymentId:'pi-a2u'}, 'A2U identifier must block')
no({...base,a2uTxid:'a2u'}, 'A2U txid must block')
no({...base,a2uPreparedTxHash:'a'.repeat(64)}, 'prepared hash must block')
no({...base,a2uPreparedSequence:'1'}, 'prepared sequence must block')
no({...base,a2uPreparedEnvelopeXdr:'xdr'}, 'prepared XDR must block')
no({...base,a2uFromAddress:'GAPP'}, 'prepared source must block')
no({...base,a2uToAddress:'GMERCHANT'}, 'prepared destination must block')
no({...base,settlementDispatchRequestedAt:now}, 'dispatch checkpoint must block')
no({...base,horizonSuccessFlag:true}, 'Horizon success must block')
no({...base,piCompletionPending:true}, 'Pi completion pending must block')
no({...base,piCompleted:true}, 'Pi completed must block')
no({...base,requiresDbReconciliation:true}, 'DB reconciliation must block')
no({...base,dbRecorded:true}, 'DB recorded must block')
no({...base,refundPaymentId:'refund-pi'}, 'refund identifier must block')
no({...base,refundTxid:'refund-tx'}, 'refund txid must block')
no({...base,refundStatus:'pending'}, 'refund lifecycle must block')

const route = readFileSync(resolve(__dirname,'../app/api/operations/payment-review/route.ts'),'utf8')
const emergency = readFileSync(resolve(__dirname,'../app/api/emergency/clear-stuck-payment/route.ts'),'utf8')
const ui = readFileSync(resolve(__dirname,'../app/emergency/page.tsx'),'utf8')
let bindings=0
const bind=(ok:boolean,msg:string)=>{bindings++;must(ok,msg)}
bind(/const safeTerminal = isTerminalNoMovementProjectionCandidate\(payment\) && refund\.state === [\"']absent[\"'] && dbNoFinancialRows/.test(route), 'POST prune must bind projection + refund absence + DB absence in the authorization predicate')
bind(route.includes('proveNoCommittedFinancialRows(payment.id)'), 'POST prune must re-read PostgreSQL at action time')
bind(route.includes('COUNT(*)::int FROM transactions WHERE payment_id=$1') && route.includes('COUNT(*)::int FROM receipts'), 'DB absence proof must cover transactions and receipts')
bind(route.includes('Dismissal of active/reviewed financial cases is disabled') && route.includes('{ status: 409 }'), 'dismiss_reviewed must fail closed')
bind(route.includes("redis.call('SREM',KEYS[1],ARGV[1])") && route.includes("redis.call('ZREM',KEYS[2],ARGV[1])"), 'prune may remove indexes only')
bind(!route.includes('redis.del(`payment:'), 'prune must never delete canonical payment')
bind(emergency.includes('Emergency clear blocked: local pending is not authoritative proof') && !emergency.includes('redis.del('), 'legacy clear-stuck route must remain inert')
bind(ui.includes('x.action.canPruneFromQueue&&<Button') && !ui.includes('"Remove from view"}</Button>'), 'UI must not expose dismiss button for unresolved cases')
console.log(`EMERGENCY_RESCUE_SAFETY=PASS adversarial=${cases} runtime_bindings=${bindings} fail_closed=true`)
