import { strict as assert } from "node:assert"
import fs from "node:fs"
import crypto from "node:crypto"
const root=new URL("../",import.meta.url)
const read=p=>fs.readFileSync(new URL(p,root),"utf8")
const profile=read("app/api/profile/route.ts")
const refund=read("lib/refund-executor.ts")
const loader=read("components/pi-sdk-loader.tsx")
const home=read("app/page.tsx")
const customer=read("components/customer-payment-view.tsx")
assert(profile.includes('action !== "dismiss_completed_refund"'))
assert(profile.includes('marker === "dismissed"'))
assert(profile.includes('return !dismissedRefundPaymentIds.has(paymentId)'))
assert(profile.includes('presentation.merchantStatus === "refund_completed"'))
assert(refund.includes("status: 'refunded', refundStatus: 'completed', settlementFailureState: 'refunded'"))
assert(!home.includes("initializePiSDK("))
assert(!customer.includes("initializePiSDK("))
assert(loader.includes("window.Pi.init"))
assert(!fs.existsSync(new URL("components/ui/use-toast.ts",root)))
const protectedFiles=["app/api/pi/approve/route.ts","app/api/pi/complete/route.ts","app/api/recovery/transient/route.ts","lib/db.ts","lib/a2u-executor.ts","lib/refund-executor.ts","lib/refund-checkpoint-store.ts","lib/pi-wallet-submit-lock.ts","vercel.json"]
const hashes=Object.fromEntries(protectedFiles.map(p=>[p,crypto.createHash("sha256").update(fs.readFileSync(new URL(p,root))).digest("hex")]))
console.log(JSON.stringify({certification:"PASS",gate:"PRE-DR118-UX2-DRIFT-PROFILE-INVARIANTS",completedRefundVisibleUntilExplicitDismissal:true,refundFinalProjectionRetained:true,singlePiInitOwner:true,orphanUseToastRemoved:true,protectedFinancialFiles:hashes},null,2))
