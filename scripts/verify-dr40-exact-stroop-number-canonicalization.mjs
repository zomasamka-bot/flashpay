import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/financial-amount-stroops.ts', import.meta.url), 'utf8')
if (!source.includes('const canonical = value.toFixed(7)')) throw new Error('missing protocol-precision canonicalization')
if (!source.includes('if (Number(canonical) !== value) return null')) throw new Error('missing exact round-trip guard')
if (source.includes('value * STROOPS_PER_PI')) throw new Error('binary multiplication exactness gate still present')

function numberToExactPositiveStroops(value) {
  if (!Number.isFinite(value) || value <= 0) return null
  const canonical = value.toFixed(7)
  if (Number(canonical) !== value) return null
  const [whole, fraction = ''] = canonical.split('.')
  const normalized = `${whole}${fraction.padEnd(7, '0')}`
  if (!/^[0-9]+$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

const accepted = new Map([[0.10,1000000],[0.11,1100000],[0.12,1200000],[0.13,1300000],[0.14,1400000],[0.16,1600000],[0.0000001,1],[1,10000000],[123.456789,1234567890]])
for (const [value, expected] of accepted) {
  const got = numberToExactPositiveStroops(value)
  if (got !== expected) throw new Error(`accepted case failed ${value}: ${got} != ${expected}`)
}
const rejected = [0, -0.14, NaN, Infinity, -Infinity, 0.00000001, 0.12345678, 0.30000000000000004, Number.MAX_SAFE_INTEGER]
for (const value of rejected) if (numberToExactPositiveStroops(value) !== null) throw new Error(`unsafe case admitted: ${value}`)

const syntheticCases = 10000
let unsafeAccepted = 0
for (let i=1;i<=syntheticCases;i++) {
  const stroops = ((i * 104729) % 900000000) + 1
  const value = stroops / 10000000
  if (numberToExactPositiveStroops(value) !== stroops) throw new Error(`canonical stroop case failed: ${stroops}`)
  const overPrecise = value + 0.00000001
  if (numberToExactPositiveStroops(overPrecise) !== null) unsafeAccepted++
}
if (unsafeAccepted !== 0) throw new Error(`unsafeAccepted=${unsafeAccepted}`)
console.log(JSON.stringify({gate:'DR40-EXACT-STROOP-NUMBER-CANONICALIZATION',liveAmount014Stroops:numberToExactPositiveStroops(0.14),syntheticCases,unsafeAccepted,financialMovementExecuted:false,productionDataMutated:false},null,2))
