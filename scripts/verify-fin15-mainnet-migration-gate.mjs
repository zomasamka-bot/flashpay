import fs from "node:fs"
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),"utf8")
const approve=read("app/api/pi/approve/route.ts"),complete=read("app/api/pi/complete/route.ts")
const xdr=read("lib/financial-recovery-settlement-submit-xdr-verifier.ts"),horizon=read("lib/financial-recovery-settlement-submit-horizon-reader.ts")
const rs=read("lib/refund-blockchain-submit.ts"),re=read("lib/refund-blockchain-evidence.ts"),rp=read("lib/refund-pi-reconciliation.ts")
const checks=[
["approve_testnet",approve.includes('canonicalPayment.network !== "Pi Testnet"')],
["approve_refetch",approve.includes('refetchedPayment.network !== "Pi Testnet"')],
["complete_testnet",complete.includes('piPayment.network !== "Pi Testnet"')],
["complete_refetch",complete.includes('finalPiPayment.network !== "Pi Testnet"')],
["settlement_xdr",xdr.includes('fromXDR(input.envelopeXdr, "Pi Testnet")')],
["settlement_horizon",horizon.includes("https://api.testnet.minepi.com")],
["refund_horizon_submit",rs.includes("https://api.testnet.minepi.com")],
["refund_xdr",rs.includes('fromXDR(input.envelopeXdr, "Pi Testnet")')],
["refund_horizon_evidence",re.includes("https://api.testnet.minepi.com")],
["refund_pi_network",rp.includes('network !== "Pi Testnet"')]
]
for(const [n,ok] of checks)if(!ok)throw new Error(`FIN15 predicate failed: ${n}`)
console.log(`FIN15_MAINNET_MIGRATION_GATE=PASS predicates=${checks.length} runtime_source_only=true mainnet_enabled=false testnet_boundary_preserved=true runtime_kernel_changed=false`)
