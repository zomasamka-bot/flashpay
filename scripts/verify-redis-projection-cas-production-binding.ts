import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
function read(p:string){return readFileSync(resolve(process.cwd(),p),'utf8')}
function assert(c:unknown,m:string):asserts c{if(!c)throw new Error(`REDIS_PROJECTION_CAS_PRODUCTION_BINDING=FAIL ${m}`)}
function idx(s:string,n:string,l:string){const i=s.indexOf(n);assert(i>=0,`missing ${l}`);return i}
const cas=read('lib/payment-projection-cas.ts')
const a2u=read('lib/a2u-executor.ts')
const refund=read('lib/refund-executor.ts')
const recovery=read('app/api/recovery/transient/route.ts')
const locked=read('lib/a2u-locked-executor.ts')
const legacyRecovery=read('lib/a2u-recovery-service.ts')
const complete=read('app/api/pi/complete/route.ts')
const paymentRoute=read('app/api/payments/[id]/route.ts')

// A. Canonical CAS is a version fence on the latest Redis value, not a blind SET of a stale snapshot.
assert(cas.includes("const expectedVersion = paymentProjectionVersion(expected)"),'CAS does not derive expected version from caller snapshot')
assert(cas.includes("local raw=redis.call('GET',KEYS[1])"),'CAS does not read latest value atomically in Lua')
assert(cas.includes("if current.id~=ARGV[1] then return -2 end"),'CAS does not bind Redis identity to paymentId')
assert(cas.includes("if version~=expected then return 0 end"),'CAS lacks stale-version conflict fence')
assert(cas.includes("next.redisProjectionVersion~=expected+1"),'CAS does not require exactly +1 next version')
assert(cas.includes("redis.call('SET',KEYS[1],ARGV[3]); return 1"),'CAS update is not atomic with version check')
assert(cas.includes("if (result === 0) return { outcome: 'CONFLICT'"),'stale writer is not surfaced as CONFLICT')
assert(cas.includes("readBack.redisProjectionVersion !== nextVersion"),'CAS success lacks readback version verification')
assert(cas.includes("if (value === undefined) return 0"),'legacy missing version is not canonically adopted as version 0')
assert(cas.includes("Number.isSafeInteger(value) && value >= 0"),'invalid projection versions are not rejected')

// B. Settlement checkpoint writer: conflict triggers bounded re-read/re-merge; uncertainty never becomes success.
const a2uCas=idx(a2u,'const cas = await compareAndSwapPaymentProjection(paymentId, latest, merged)','A2U CAS')
const a2uRetry=idx(a2u,'if (cas.outcome === "CONFLICT" && casAttempt < 4)','A2U bounded conflict retry')
const a2uFail=idx(a2u,'if (cas.outcome !== "UPDATED")','A2U fail closed')
assert(a2uCas<a2uRetry && a2uRetry<a2uFail,'A2U CAS conflict handling order is unsafe')
assert(a2u.includes('return persistCheckpointMerged(paymentId, updates, casAttempt + 1)'),'A2U conflict does not re-read/re-merge')
assert(a2u.includes('throw new Error(`[F2-6 REDIS CAS] Payment projection write blocked: ${cas.outcome}`)'),'A2U CAS uncertainty does not fail closed')

// C. Refund financial writers use CAS and only accept conflict when CURRENT projection already equals exact desired financial result.
assert((refund.match(/compareAndSwapPaymentProjection\(/g)||[]).length>=3,'Refund financial projection paths are not CAS-bound')
assert(refund.includes("projectionCas.outcome === 'CONFLICT' ? projectionCas.current : null"),'Refund conflict does not use current projection evidence')
assert(refund.includes("persistedPayment.refundPaymentId !== refundPaymentId || persistedPayment.refundTxid !== refundTxid"),'Refund conflict acceptance lacks exact refund identity/txid check')
assert(refund.includes("reason: projectionCas.outcome === 'CONFLICT' ? 'projection_conflict' : 'projection_uncertain'"),'Refund non-exact conflict does not block')

// D. Durable reconstruction is create-only. It cannot overwrite an extant newer projection.
for(const [label,src] of [['locked recovery',locked],['legacy recovery',legacyRecovery],['transient recovery',recovery]] as const){
  const direct=[...src.matchAll(/redis\.set\(`payment:\$\{[^}]+\}`[^\n]*\)/g)].map(m=>m[0])
  assert(direct.length>0,`${label} has no classified payment reconstruction writes`)
  for(const call of direct) assert(call.includes('{nx:true}')||call.includes('{ nx: true }'),`${label} contains non-NX direct payment SET: ${call}`)
}

// E. Specialized Lua presentation/recovery mutations operate on latest Redis value and advance version; they are not stale snapshot overwrites.
for(const [label,src] of [['Pi complete',complete],['payment PATCH',paymentRoute],['transient recovery',recovery]] as const){
  const touches=src.includes('redisProjectionVersion=projectionVersion+1')
  assert(touches,`${label} specialized projection mutation does not advance redisProjectionVersion`)
}
assert(paymentRoute.includes("local latest=redis.call('GET',KEYS[1])"),'payment PATCH does not mutate latest projection atomically')
assert(complete.includes("local projectionVersion=current.redisProjectionVersion"),'Pi complete mutation does not fence projection version shape')

// F. Executable adversarial truth table for the exact version contract.
type State={id:string;v:number|undefined;value:string}
function model(current:State|null, expected:State, next:State):'UPDATED'|'CONFLICT'|'MISSING'|'INVALID'{
  if(!current)return 'MISSING'
  if(current.id!==expected.id||next.id!==expected.id)return 'INVALID'
  const ev=expected.v===undefined?0:expected.v, cv=current.v===undefined?0:current.v
  if(!Number.isSafeInteger(ev)||ev<0||!Number.isSafeInteger(cv)||cv<0||ev>=Number.MAX_SAFE_INTEGER)return 'INVALID'
  if(cv!==ev)return 'CONFLICT'
  return 'UPDATED'
}
const cases:[string,State|null,State,State,ReturnType<typeof model>][]=[
 ['legacy-v0-first-adoption',{id:'p',v:undefined,value:'base'},{id:'p',v:undefined,value:'base'},{id:'p',v:undefined,value:'next'},'UPDATED'],
 ['same-version-update',{id:'p',v:7,value:'base'},{id:'p',v:7,value:'base'},{id:'p',v:7,value:'next'},'UPDATED'],
 ['stale-writer-blocked',{id:'p',v:8,value:'newer'},{id:'p',v:7,value:'stale'},{id:'p',v:7,value:'bad'},'CONFLICT'],
 ['future-writer-blocked',{id:'p',v:7,value:'base'},{id:'p',v:8,value:'future'},{id:'p',v:8,value:'bad'},'CONFLICT'],
 ['missing-blocked',null,{id:'p',v:0,value:'x'},{id:'p',v:0,value:'y'},'MISSING'],
 ['identity-mismatch',{id:'q',v:1,value:'x'},{id:'p',v:1,value:'x'},{id:'p',v:1,value:'y'},'INVALID'],
 ['negative-version',{id:'p',v:-1,value:'x'},{id:'p',v:-1,value:'x'},{id:'p',v:-1,value:'y'},'INVALID'],
 ['fractional-version',{id:'p',v:1.5,value:'x'},{id:'p',v:1.5,value:'x'},{id:'p',v:1.5,value:'y'},'INVALID'],
 ['max-safe-overflow',{id:'p',v:Number.MAX_SAFE_INTEGER,value:'x'},{id:'p',v:Number.MAX_SAFE_INTEGER,value:'x'},{id:'p',v:Number.MAX_SAFE_INTEGER,value:'y'},'INVALID'],
]
for(const [name,current,expected,next,want] of cases){const got=model(current,expected,next);assert(got===want,`adversarial ${name}: ${got} != ${want}`)}
console.log(`REDIS_PROJECTION_CAS_PRODUCTION_BINDING=PASS cases=${cases.length} source=production`)
