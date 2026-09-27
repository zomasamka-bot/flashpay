import fs from "node:fs"
const src = fs.readFileSync("app/pay/[id]/payment-content-with-id.tsx", "utf8")
const entry = fs.readFileSync("app/api/pi/entry-token/route.ts", "utf8")
const checks = [
  ["no unsupported browser.open wrapper", !src.includes("pi://browser.open?url=")],
  ["direct pi protocol is constructed", src.includes('target.protocol = "pi:"')],
  ["exact production payment path is constructed", src.includes('https://flashpay-two.vercel.app/pay/${encodeURIComponent(paymentId)}')],
  ["signed bridge token remains attached", src.includes('target.searchParams.set("bridge", data.token)')],
  ["entry mode remains pi", src.includes('target.searchParams.set("entry", "pi")')],
  ["server verifies paymentId-token binding", entry.includes('decoded?.paymentId === paymentId')],
  ["invalid entry remains fail closed", entry.includes('PI_ENTRY_INVALID')],
  ["Pi SDK init remains gated by verified entry", src.includes('if (entryMode === "pi" && piEntryVerified)')],
  ["pay handler remains gated by verified entry", src.includes('entryMode !== "pi" || piEntryVerified !== true')],
]
let failed = false
for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed = true }
if (failed) process.exit(1)
console.log("DR90 DIRECT PI ENTRY LINK: PASS")
