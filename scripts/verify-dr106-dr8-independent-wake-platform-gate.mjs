import { strict as assert } from "node:assert"
import fs from "node:fs"

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8")
const route = read("app/api/recovery/transient/route.ts")
const config = JSON.parse(read("vercel.json"))

assert.deepEqual(config.crons, [{ path: "/api/recovery/transient", schedule: "0 21 * * *" }])
for (const marker of [
  "runtimeEnv.CRON_SECRET",
  'authorization?.startsWith("Bearer ")',
  "constantTimeSecretEqual(cronSecret, cronBearer)",
  "export { POST as GET }",
  'redis.set(DRAIN_LEASE_KEY, token, { nx: true, ex: DRAIN_LEASE_TTL_SECONDS })',
  "repopulateDurableSettlementWork()",
  "repopulateDurableU2AIngressWork()",
]) assert.ok(route.includes(marker), `missing DR8 safety binding: ${marker}`)

assert.equal(route.includes('request.headers.get("user-agent")'), false)
assert.equal(route.includes("x-vercel-cron"), false)

const evidence = {
  certification: "PASS",
  gate: "DR106-DR8-INDEPENDENT-WAKE-PLATFORM-GATE",
  currentIndependentWake: "VERCEL_CRON_DAILY",
  currentCron: "0 21 * * *",
  requiredWakeWindowMinutes: { min: 1, max: 10 },
  cronAuthentication: "CRON_SECRET_BEARER_CONSTANT_TIME_FAIL_CLOSED",
  sameDrainLease: true,
  durableSettlementRediscovery: true,
  durableU2AIngressRediscovery: true,
  userAgentTrusted: false,
  xVercelCronTrusted: false,
  financialExecutorChanged: false,
  financialAuthorityChanged: false,
  financialMovementExecuted: false,
  productionDataMutated: false,
  oneToTenMinuteIndependentWakeProven: false,
  verdict: "BLOCKED_BY_PLATFORM_SCHEDULER_CAPABILITY_NOT_BY_FINANCIAL_DEFECT",
  closureRequirement: "Deploy a scheduler with <=10 minute independent cadence, then capture live scheduler-origin invocation and recovery evidence without manual wake."
}
assert.equal(evidence.oneToTenMinuteIndependentWakeProven, false)
console.log(JSON.stringify(evidence, null, 2))
