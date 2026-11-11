// KERNEL-1: original guarded handlers; no host financial decisions.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export { GET } from "@flashpay/financial-kernel/handlers/refunds/customer-status/route"
