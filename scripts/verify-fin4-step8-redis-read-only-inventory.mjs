import fs from 'node:fs'
const p='app/api/certification/step8-redis-inventory/route.ts'
const s=fs.readFileSync(p,'utf8')
const assert=(c,m)=>{if(!c)throw new Error(`FIN4_STEP8_REDIS_INVENTORY=FAIL ${m}`)}
for(const x of ['flashpay:cert:fin4:r4e:v1:','flashpay:cert:fin4:r4t:lock-probe:','FIN4-20261005-1643-D50D',':events','redis.scan','redis.exists','redis.type','redis.ttl','mutationExecuted: false']) assert(s.includes(x),`missing ${x}`)
for(const x of ['redis.del(','redis.unlink(','redis.set(','redis.expire(','flushdb','flushall']) assert(!s.toLowerCase().includes(x.toLowerCase()),`mutation primitive present ${x}`)
assert(!s.includes('payment:*'),'payment key scan forbidden')
assert(!s.includes('flashpay:wallet:'),'wallet key access forbidden')
console.log('FIN4_STEP8_REDIS_READ_ONLY_INVENTORY=PASS exact_prefixes=2 mutation_primitives=0 financial_keys=untouched')
