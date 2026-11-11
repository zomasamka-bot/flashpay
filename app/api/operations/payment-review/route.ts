// KERNEL-1: original guarded handlers; no host financial decisions.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export { GET, POST } from "@flashpay/financial-kernel/handlers/operations/payment-review/route"
