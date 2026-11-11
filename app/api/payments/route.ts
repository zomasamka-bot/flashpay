// KERNEL-1: original guarded handlers; no host financial decisions.
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60
export { OPTIONS, POST, GET } from "@flashpay/financial-kernel/handlers/payments/route"
