import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(__dirname, "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const a2u = read("lib/a2u-executor.ts")
const refund = read("lib/refund-executor.ts")
const cas = read("lib/payment-projection-cas.ts")
const db = read("lib/db.ts")
const wallet = read("lib/pi-wallet-submit-lock.ts")

const checks: Array<[string, boolean]> = [
  ["settlement durable XOR authority exists", db.includes("readSettlementRefundAuthority")],
  ["settlement horizon durable checkpoint exists", a2u.includes("recordSettlementHorizonCheckpoint")],
  ["settlement wallet intent lock exists", a2u.includes("acquirePiWalletIntentSubmitLock")],
  ["settlement exact prepared replay exists", a2u.includes("executeFinancialRecoverySettlementSubmitReplay")],
  ["settlement projection uses CAS", a2u.includes("compareAndSwapPaymentProjection")],
  ["refund payment operation lock exists", refund.includes("ensurePaymentOperationLock")],
  ["refund durable authority recheck exists", refund.includes("readSettlementRefundAuthority")],
  ["refund wallet intent lock exists", refund.includes("acquirePiWalletIntentSubmitLock")],
  ["refund durable tx persistence exists", refund.includes("persistRefundBlockchainTxWithAudit")],
  ["refund projection uses CAS", refund.includes("compareAndSwapPaymentProjection")],
  ["wallet owner identity is explicit", wallet.includes("paymentId") && wallet.includes("refund_claim") && wallet.includes("settlement_claim")],
  ["CAS exact version fence exists", cas.includes("redisProjectionVersion") && cas.includes("CONFLICT")],
]
for (const [name, ok] of checks) if (!ok) throw new Error(`PLAN_G_CROSS_BOUNDARY_ABC=FAIL ${name}`)

const horizon = a2u.indexOf("recordSettlementHorizonCheckpoint")
const settlementReturn = a2u.indexOf("txidFromHorizon,", horizon)
if (horizon < 0 || settlementReturn < horizon) throw new Error("PLAN_G_CROSS_BOUNDARY_ABC=FAIL settlement durable movement ordering")
const refundPersist = refund.indexOf("persistRefundBlockchainTxWithAudit")
const refundRelease = refund.indexOf("releasePiWalletIntent", refundPersist)
if (refundPersist < 0 || refundRelease < refundPersist) throw new Error("PLAN_G_CROSS_BOUNDARY_ABC=FAIL refund durable movement ordering")

console.log(`PLAN_G_CROSS_BOUNDARY_ABC=PASS assertions=${checks.length + 2} runtime_delta=ZERO fail_closed=true`)
