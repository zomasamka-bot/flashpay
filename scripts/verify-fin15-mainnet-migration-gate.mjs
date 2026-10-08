import fs from "node:fs"
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),"utf8")
const approve=read("app/api/pi/approve/route.ts"),complete=read("app/api/pi/complete/route.ts")
const xdr=read("lib/financial-recovery-settlement-submit-xdr-verifier.ts"),horizon=read("lib/financial-recovery-settlement-submit-horizon-reader.ts")
const rs=read("lib/refund-blockchain-submit.ts"),re=read("lib/refund-blockchain-evidence.ts"),rp=read("lib/refund-pi-reconciliation.ts")
const ev=read("certification/FIN15_MAINNET_MIGRATION_GATE_FINAL_EVIDENCE.md")
const checks=[
["approve_testnet",approve.includes('canonicalPayment.network !== "Pi Testnet"')],["approve_refetch",approve.includes('refetchedPayment.network !== "Pi Testnet"')],
["complete_testnet",complete.includes('piPayment.network !== "Pi Testnet"')],["complete_refetch",complete.includes('finalPiPayment.network !== "Pi Testnet"')],
["settlement_xdr",xdr.includes('fromXDR(input.envelopeXdr, "Pi Testnet")')],["settlement_horizon",horizon.includes("https://api.testnet.minepi.com")],
["refund_horizon_submit",rs.includes("https://api.testnet.minepi.com")],["refund_xdr",rs.includes('fromXDR(input.envelopeXdr, "Pi Testnet")')],
["refund_horizon_evidence",re.includes("https://api.testnet.minepi.com")],["refund_pi_network",rp.includes('network !== "Pi Testnet"')],
["durable_profile",ev.includes("networkProfileVersion")&&ev.includes("networkId")],["legacy_testnet",ev.includes("classified explicitly as Testnet legacy")],
["no_default_mainnet",ev.includes("MUST NOT inherit a current/default Mainnet profile")],["atomic_profile",ev.includes("network profile is an indivisible contract")],
["secret_separation",ev.includes("Testnet and Mainnet source wallets and credentials MUST be distinct")],["canonical_ingress",ev.includes("Client claims, Redis values, request metadata, or environment defaults cannot establish network truth")],
["settlement_same_profile",ev.includes("submitted under the same frozen network profile")],["cross_network_refund_blocked",ev.includes("Cross-network refunds are forbidden")],
["accounting_no_mix",ev.includes("without mixing Testnet and Mainnet evidence")],["recovery_recertified",ev.includes("MUST be re-certified independently on Mainnet-capable source")],
["redis_projection",ev.includes("Redis remains projection/coordination only")],["distinct_activation_release",ev.includes("Mainnet enablement requires a distinct release")],
["rollback_preserves_domain",ev.includes("MUST NOT reinterpret, delete, or silently move already-owned Mainnet financial lifecycles to Testnet")],
["no_enable",ev.includes("Mainnet enabled: NO")&&ev.includes("Testnet boundary changed: NO")&&ev.includes("Runtime financial kernel changed: NO")]
]
for(const [n,ok] of checks)if(!ok)throw new Error(`FIN15 predicate failed: ${n}`)
console.log(`FIN15_MAINNET_MIGRATION_GATE=PASS predicates=${checks.length} design_only=true mainnet_enabled=false testnet_boundary_preserved=true runtime_kernel_changed=false`)
