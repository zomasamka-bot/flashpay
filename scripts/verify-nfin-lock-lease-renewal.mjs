import fs from 'node:fs'
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const wallet=read('lib/pi-wallet-submit-lock.ts')
const locked=read('lib/a2u-locked-executor.ts')
const recovery=read('lib/a2u-recovery-service.ts')
const checks=[
 ['wallet-token-compare',wallet.includes('current ~= ARGV[1]')&&wallet.includes('return redis.call("EXPIRE", KEYS[1], ARGV[2])')],
 ['wallet-renew-before-expiry',wallet.includes('SUBMIT_LOCK_TTL_SECONDS = 600')&&wallet.includes('SUBMIT_LOCK_RENEW_INTERVAL_MS = 180_000')],
 ['wallet-release-stops-renewal',wallet.includes('clearInterval(renewalTimer)')&&wallet.includes('RELEASE_SCRIPT')],
 ['payment-operation-renewal',locked.includes('lockRenewalTimer = setInterval')&&locked.includes('[lockToken, String(lockTtl)]')&&locked.includes('180_000')],
 ['payment-operation-release-stops-renewal',locked.includes('if (lockRenewalTimer) { clearInterval(lockRenewalTimer); lockRenewalTimer = null }')],
 ['recovery-operation-renewal',recovery.includes('const lockRenewalTimer = setInterval')&&recovery.includes('[lockToken, "600"]')&&recovery.includes('180_000')],
 ['recovery-release-stops-renewal',recovery.includes('clearInterval(lockRenewalTimer)')],
]
const failed=checks.filter(([,ok])=>!ok).map(([name])=>name)
console.log(JSON.stringify({certification:failed.length?'FAIL':'PASS',gate:'FINANCIAL-LOCK-LEASE-RENEWAL',checks:Object.fromEntries(checks),failed},null,2))
if(failed.length)process.exit(1)
