import fs from "node:fs"
import path from "node:path"

const root = path.resolve(__dirname, "..")
const route = fs.readFileSync(path.join(root, "app/api/certification/fin4-trigger/route.ts"), "utf8")
const reader = fs.readFileSync(path.join(root, "lib/fin4-pi-pretransaction-reader.ts"), "utf8")
function must(condition: boolean, message: string) { if (!condition) throw new Error(`FIN4_R4I_VERIFY_FAIL: ${message}`) }
must(route.includes('evidence") === "pi-pretransaction"'), "read-only Pi pre-transaction evidence endpoint missing")
must(route.includes('fin4ArmedPaymentForRole(runId, "B")'), "probe must scope to exact armed B/C payment")
must(route.includes('readFin4PiPretransactionEvidence({ paymentId, piPaymentId })'), "route must delegate to isolated read-only reader")
must(reader.includes('method: "GET"'), "Pi evidence reader must use GET")
must(reader.includes('api.minepi.com/v2/payments/${encodeURIComponent(piPaymentId)}'), "reader must read exact Pi payment identifier")
must(reader.includes('metadataPaymentId !== paymentId'), "Pi metadata must match exact armed payment")
must(reader.includes('financialAuthorityMutated: false'), "probe must declare no financial authority mutation")
must(reader.includes('piMutationExecuted: false'), "probe must declare no Pi mutation")
must(reader.includes('horizonSubmitExecuted: false'), "probe must declare no Horizon submit")
must(reader.includes('redisMutated: false'), "probe must declare no Redis mutation")
must(!reader.includes('method: "POST"'), "reader must not POST")
must(!reader.includes('server.submitTransaction'), "reader must not submit Horizon")
must(!reader.includes('redis.') && !reader.includes('recordSettlement') && !reader.includes('createRefund') && !reader.includes('fin4ClaimLaunchForArmedRun'), "reader must have no Redis, durable writer, refund, or launch authority")
console.log("FIN4_R4I_PI_PRETRANSACTION_PROBE=PASS exact_armed_scope=true isolated_reader=true pi_get_only=true financial_authority=false pi_mutation=false horizon_submit=false redis_mutation=false")
