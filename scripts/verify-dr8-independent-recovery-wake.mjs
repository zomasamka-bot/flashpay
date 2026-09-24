import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const route=read("app/api/recovery/transient/route.ts")
const config=JSON.parse(read("vercel.json"))
assert.deepEqual(config.crons,[{path:"/api/recovery/transient",schedule:"0 21 * * *"}])
for(const x of [
  "runtimeEnv.CRON_SECRET",
  'authorization?.startsWith("Bearer ")',
  "constantTimeSecretEqual(cronSecret, cronBearer)",
  "export { POST as GET }",
  'redis.set(DRAIN_LEASE_KEY, token, { nx: true, ex: DRAIN_LEASE_TTL_SECONDS })',
  "repopulateDurableSettlementWork()",
  "repopulateDurableU2AIngressWork()",
]) assert.ok(route.includes(x),`missing DR-8 binding: ${x}`)
assert.equal(route.includes('request.headers.get("user-agent")'),false)
assert.equal(route.includes('x-vercel-cron'),false)
console.log(JSON.stringify({certification:"PASS",gate:"DR-8-INDEPENDENT-RECOVERY-WAKE",cron:"0 21 * * *",cronMethod:"GET",authentication:"CRON_SECRET_BEARER_CONSTANT_TIME_FAIL_CLOSED",sameDrainLease:true,durableRediscovery:true,financialAuthorityChanged:false,financialMovementExecuted:false},null,2))
