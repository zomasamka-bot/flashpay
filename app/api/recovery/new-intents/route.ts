// KERNEL-1: original guarded handlers; no host financial decisions.
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300
export { GET, POST } from "@flashpay/financial-kernel/handlers/recovery/new-intents/route"
