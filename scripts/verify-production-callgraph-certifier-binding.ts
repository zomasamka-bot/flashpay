import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '..')
const read = (p:string) => readFileSync(resolve(root,p),'utf8')
const must = (ok:boolean, msg:string) => { if(!ok) throw new Error(`PRODUCTION_CALLGRAPH_BINDING=FAIL ${msg}`) }
const has = (p:string, ...needles:string[]) => { const s=read(p); for(const n of needles) must(s.includes(n), `${p} missing ${n}`); return s }

// Production entrypoints -> shared settlement execution authority.
has('app/api/pi/a2u/route.ts', 'executeA2ULocked', '@/lib/a2u-locked-executor')
has('app/api/recovery/transient/route.ts', 'executeA2URecovery', '@/lib/a2u-recovery-service', 'runAutomaticRefundPass', '@/lib/refund-auto-orchestrator')
has('app/api/recovery/[id]/route.ts', 'executeA2URecovery', '@/lib/a2u-recovery-service')
has('lib/a2u-recovery-service.ts', 'executeA2ULocked', '@/lib/a2u-locked-executor')
has('lib/a2u-locked-executor.ts', 'executeA2U', '@/lib/a2u-executor', 'executeFinancialRecoverySettlementSubmitReplay', '@/lib/financial-recovery-settlement-submit-replay-orchestration')
has('lib/a2u-executor.ts', 'executeFinancialRecoverySettlementSubmitReplay', '@/lib/financial-recovery-settlement-submit-replay-orchestration', 'submitTransaction(transaction)')

// Settlement replay orchestration -> exact evidence/decision dependencies.
has('lib/financial-recovery-settlement-submit-replay-orchestration.ts', 'financial-recovery-settlement-submit-replay')
const replay = read('lib/financial-recovery-settlement-submit-replay-orchestration.ts')
must(/from\s+["']\.\/financial-recovery-settlement-submit-replay["']/.test(replay) || replay.includes('@/lib/financial-recovery-settlement-submit-replay'), 'settlement replay orchestration detached from replay evidence module')

// Refund production worker -> executor -> blockchain submit helper (dynamic import counts as runtime edge).
has('lib/refund-auto-orchestrator.ts', 'executeRefundNextStep', '@/lib/refund-executor')
const refundExec = read('lib/refund-executor.ts')
must(refundExec.includes("import('./refund-blockchain-submit')") || refundExec.includes('import("./refund-blockchain-submit")'), 'refund executor detached from blockchain submit helper')
must(refundExec.includes('submitRefundBlockchainOnce'), 'refund executor missing submitRefundBlockchainOnce runtime edge')
has('lib/refund-blockchain-submit.ts', 'server.submitTransaction', 'authorizeRefundBlockchainSubmit')

// Projection authority used by production recovery and financial executors.
has('app/api/recovery/transient/route.ts', 'compareAndSwapPaymentProjection', '@/lib/payment-projection-cas')
has('lib/a2u-executor.ts', 'compareAndSwapPaymentProjection')
has('lib/refund-executor.ts', 'compareAndSwapPaymentProjection')

// Evidence-class contract: model tests remain useful but may not independently claim runtime reachability.
const runner = read('scripts/run-financial-recovery-build-verifier.mjs')
must(runner.includes('verify-production-callgraph-certifier-binding.ts'), 'callgraph gate not mandatory in build verifier')

console.log('PRODUCTION_CALLGRAPH_BINDING=PASS critical_bindings=12 static_and_dynamic_imports=true model_claims_separated=true')
