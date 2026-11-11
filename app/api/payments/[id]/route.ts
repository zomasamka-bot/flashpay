// KERNEL-1: original guarded handlers; no host financial decisions.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export { GET, PATCH } from "@flashpay/financial-kernel/handlers/payments/[id]/route"
