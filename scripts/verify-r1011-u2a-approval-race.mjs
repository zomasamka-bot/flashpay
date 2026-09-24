import { strict as assert } from "node:assert"
import fs from "node:fs"

const route = fs.readFileSync(new URL("../app/api/pi/approve/route.ts", import.meta.url), "utf8")
const db = fs.readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8")

const approvalCall = route.indexOf('`https://api.minepi.com/v2/payments/${identifier}/approve`')
assert.ok(approvalCall > 0, "Pi /approve call not found")
const preApproval = route.slice(0, approvalCall)

// R101-1 asks one narrow question: before Pi /approve, is there any durable
// paymentId -> identifier ownership claim that can distinguish A from B?
const durableClaimBindings = [
  "recordU2AApprovalClaim",
  "recordSettlementU2AApproval",
  "u2a_approval_identifier",
  "approval_identifier",
]
for (const binding of durableClaimBindings) {
  assert.equal(preApproval.includes(binding), false, `unexpected pre-approve durable ownership binding: ${binding}`)
}
assert.equal(preApproval.includes("recordSettlementPaymentIdentityCheckpoint"), false, "approve route must not confuse payment identity with approval ownership")
assert.ok(preApproval.includes("canonicalPayment.amount !== redisPayment.amount"), "amount gate missing")
assert.ok(preApproval.includes('canonicalPayment.direction !== "user_to_app"'), "direction gate missing")
assert.ok(preApproval.includes('redisPayment.status?.toLowerCase() !== "pending"'), "pending gate missing")
assert.ok(preApproval.includes("canonicalPayment.metadata?.paymentId"), "canonical metadata binding missing")

// Adversarial proof model: two distinct canonical Pi objects can satisfy every
// current pre-approval gate for the same local payment because identifier is
// checked only against itself and is not owned durably by paymentId.
const local = { id: "flashpay-payment-1", amount: 0.25, status: "pending" }
const canonical = (identifier) => ({
  identifier,
  amount: 0.25,
  direction: "user_to_app",
  metadata: { paymentId: local.id },
  status: { cancelled: false, user_cancelled: false },
})
function currentPreApprovalGates(identifier, pi, redisPayment) {
  if (pi.identifier !== identifier) return false
  const paymentId = pi.metadata?.paymentId
  if (typeof paymentId !== "string" || paymentId.length === 0 || paymentId !== paymentId.trim()) return false
  if (!redisPayment || redisPayment.id !== paymentId) return false
  if (redisPayment.status === "paid_to_app") return redisPayment.piPaymentId === identifier
  if (pi.amount !== redisPayment.amount) return false
  if (pi.direction !== "user_to_app") return false
  if (pi.status?.cancelled || pi.status?.user_cancelled) return false
  if (redisPayment.status?.toLowerCase() !== "pending") return false
  return true
}
const A = canonical("pi-A")
const B = canonical("pi-B")
assert.equal(currentPreApprovalGates(A.identifier, A, local), true)
assert.equal(currentPreApprovalGates(B.identifier, B, local), true)
assert.notEqual(A.identifier, B.identifier)

// The existing durable payment_identity row cannot resolve A vs B: its schema
// contains no approval-ownership identifier before U2A verification.
const tableStart = db.indexOf("CREATE TABLE IF NOT EXISTS settlement_checkpoints")
const tableEnd = db.indexOf("created_at TIMESTAMP", tableStart)
assert.ok(tableStart >= 0 && tableEnd > tableStart)
const settlementSchema = db.slice(tableStart, tableEnd)
assert.ok(settlementSchema.includes("payment_id TEXT PRIMARY KEY"))
assert.ok(settlementSchema.includes("u2a_identifier TEXT"))
assert.equal(settlementSchema.includes("u2a_approval_identifier"), false)

console.log(JSON.stringify({
  certification: "PASS",
  gate: "R101-1-U2A-APPROVAL-RACE-PROOF",
  finding: "CONFIRMED",
  adversarialCase: "A_THEN_B_SAME_FLASHPAY_PAYMENT",
  APassesCurrentPreApprovalGates: true,
  BPassesCurrentPreApprovalGates: true,
  durableApprovalOwnershipBeforePiApprove: false,
  financialMovementExecuted: false,
  piNetworkCalled: false,
  secretsRead: false,
  next: "R101-2-DURABLE-U2A-APPROVAL-CLAIM"
}, null, 2))
