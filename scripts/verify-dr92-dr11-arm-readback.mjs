import fs from 'node:fs'
const page=fs.readFileSync('app/page.tsx','utf8')
const route=fs.readFileSync('app/api/control/dr11/route.ts','utf8')
const checks={
 readOnlyConfirmation: route.includes('READ_DR11_NEXT_010_PAYMENT_ARM'),
 readsRedisValue: route.includes('redis.get(ARM_KEY)'),
 readsRedisTtl: route.includes('redis.ttl(ARM_KEY)'),
 noTtlExtensionInReadback: !route.slice(route.indexOf('if (confirmation === ARM_STATUS_CONFIRM)'), route.indexOf('if (confirmation === ARM_CONFIRM)')).includes('redis.set'),
 uiReadback: page.includes('readDr11ArmStatus'),
 refreshRecovery: page.includes('setDr14RefundPrepared(armed)'),
 preCreateGate: page.includes('DR11 arm readback unavailable; payment generation blocked'),
 exactArmIdentity: page.includes('body.certification === "DR11_ARMED"') && page.includes('body.ttlSeconds > 0'),
}
const failed=Object.entries(checks).filter(([,v])=>!v)
console.log(JSON.stringify({certifier:'DR92_DR11_ARM_READBACK',checks,pass:failed.length===0},null,2))
if(failed.length) process.exit(1)
