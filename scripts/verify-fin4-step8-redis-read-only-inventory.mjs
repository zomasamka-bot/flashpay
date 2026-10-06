import fs from "node:fs"
const p = "app/api/certification/step8-redis-inventory/route.ts"
const s = fs.readFileSync(p, "utf8")
const must = [
  'const R4E_PREFIX = "flashpay:cert:fin4:r4e:v1:"',
  'const R4T_PREFIX = "flashpay:cert:fin4:r4t:lock-probe:"',
  "redis.scan(", "redis.type(", "redis.ttl(",
  "valuesRead: false", "mutationExecuted: false", "financialAuthorityMutated: false",
]
for (const x of must) if (!s.includes(x)) throw new Error(`STEP8_MISSING:${x}`)
for (const x of ["redis.del(","redis.unlink(","redis.set(","redis.flushdb(","redis.flushall(","redis.expire(","redis.get(","redis.mget(","redis.hget(","redis.lrange("]) if (s.includes(x)) throw new Error(`STEP8_MUTATION_OR_VALUE_READ:${x}`)
if (/payment:\*|flashpay:wallet:|recovery:|lease:|queue:|index:/i.test(s)) throw new Error("STEP8_FINANCIAL_KEY_SCOPE_PRESENT")
console.log("FIN4_STEP8_REDIS_READ_ONLY_INVENTORY=PASS exact_prefixes=2 values_read=0 mutation_primitives=0 financial_keys=untouched")
