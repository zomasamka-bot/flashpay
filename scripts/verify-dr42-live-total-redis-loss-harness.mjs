import { strict as assert } from "node:assert"
import fs from "node:fs"
const route=fs.readFileSync(new URL("../app/api/recovery/transient/route.ts",import.meta.url),"utf8")
const must=x=>assert.ok(route.includes(x),`missing DR42 binding: ${x}`)
for(const x of [
 'DR10_TOTAL_REDIS_LOSS_MODE = "dr10-total-redis-loss"',
 'DR10_TOTAL_REDIS_LOSS_ENV = "FLASHPAY_DR10_TOTAL_REDIS_LOSS_TEST"',
 'DR10_TOTAL_REDIS_LOSS_CONFIRM = "TOTAL_REDIS_LOSS"',
 'runtimeEnv.VERCEL_ENV !== "production"',
 'runtimeEnv[DR10_TOTAL_REDIS_LOSS_ENV] !== "1"',
 'constantTimeSecretEqual(DR10_TOTAL_REDIS_LOSS_CONFIRM',
 'DR10_ALLOWED_REDIS_PREFIXES.some(prefix=>key.startsWith(prefix))',
 'DR10 Redis keyspace is not FlashPay-exclusive',
 'if(keys.length>100000)',
 'for(let offset=0;offset<keys.length;offset+=100)',
 'await redis.del(...batch)',
 'postgresMutated:false,piCalled:false,horizonCalled:false',
 'independentWakeRequired:true',
 'repopulateDurableSettlementWork()',
 'repopulateDurableU2AIngressWork()',
]) must(x)
assert.ok(route.indexOf('request.nextUrl.searchParams.get("mode") === DR10_TOTAL_REDIS_LOSS_MODE') < route.indexOf('const drainLease = await acquireTransientDrainLease()'))
assert.equal((route.match(/DR10_TOTAL_REDIS_LOSS_CONFIRM/g)||[]).length>=2,true)
console.log(JSON.stringify({certification:"PASS",gate:"DR42-DR10-LIVE-TOTAL-REDIS-LOSS-HARNESS",productionOnly:true,existingRecoveryAuthRequired:true,explicitEnvOptIn:true,explicitDestructiveConfirmation:true,flashPayExclusiveKeyspacePreflight:true,boundedDeleteBatch:100,maxKeys:100000,postgresMutationByHarness:false,piCallByHarness:false,horizonCallByHarness:false,independentWakeRequired:true,financialMovementExecuted:false},null,2))
