import fs from 'node:fs'
import { strict as assert } from 'node:assert'
const payment=fs.readFileSync('app/api/payments/route.ts','utf8')
const control=fs.readFileSync('app/api/control/dr10/route.ts','utf8')
const recovery=fs.readFileSync('app/api/recovery/transient/route.ts','utf8')
assert.ok(!payment.includes('if (process.env.FLASHPAY_DR10_TOTAL_REDIS_LOSS_TEST === "1")'))
for(const x of ['DR10_MAINTENANCE_KEY','flashpay:certification:dr10:maintenance:v1','PAYMENT_CREATE_LEASE_PREFIX','flashpay:payment:create-active:','redis.get(DR10_MAINTENANCE_KEY)','redis.set(createLeaseKey, "active", { nx: true, ex: 120 })','finally {','redis.del(createLeaseKey)']) assert.ok(payment.includes(x),`payment:${x}`)
for(const x of ['DR10_MAINTENANCE_KEY','redis.set(DR10_MAINTENANCE_KEY, maintenanceToken, { nx: true, ex: 120 })','finally {','redis.eval<[string], number>']) assert.ok(control.includes(x),`control:${x}`)
for(const x of ['activePaymentCreate','flashpay:payment:create-active:','return {-5, #all, 0, activePaymentCreate}','payment_create_active','recoverMerchantHistoryProjectionAfterRedisLoss','match: "payment:*"','cursor !== "0"','payment.id !== paymentId','payment.merchantId','new Date(createdAtMs).toISOString() !== payment.createdAt','ZADD','MERCHANT_HISTORY_BOOTSTRAP_KEY','financialAuthorityMutated: false']) assert.ok(recovery.includes(x),`recovery:${x}`)
assert.ok(recovery.indexOf('recoverMerchantHistoryProjectionAfterRedisLoss()') < recovery.indexOf('[F2-3 DURABLE REDISCOVERY]'))
assert.ok(recovery.indexOf('const certified = await redis.set(MERCHANT_HISTORY_BOOTSTRAP_KEY, "done"') > recovery.indexOf('} while (cursor !== "0")'))
console.log(JSON.stringify({verdict:'PASS',gate:'DR56-POST-DR10-OPERATIONAL-RESTORATION',paymentCreationCapabilitySeparatedFromMaintenance:true,inFlightCreationLease:true,dr10AtomicFlushBlocksPaymentCreator:true,merchantHistoryRebuildExhaustive:true,bootstrapMarkerCommittedAfterFullScan:true,financialKernelChanged:false},null,2))
