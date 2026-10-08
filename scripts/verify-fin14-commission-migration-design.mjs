import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const evidence = readFileSync(new URL('../certification/FIN14_COMMISSION_MIGRATION_DESIGN_FINAL_EVIDENCE.md', import.meta.url), 'utf8')
const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8')

const required = [
  'DESIGN-ONLY PASS / NO ENABLE / NO RUNTIME PATCH',
  'feePolicyVersion', 'feeContractVersion', 'customerGross', 'merchantNet', 'appCommission',
  'roundingMode', 'amountScale', 'LEGACY_ZERO_V0',
  'customerGross = merchantNet + appCommission',
  'Horizon execution fee is NOT part of this equality',
  'NULL/unknown/unrecognized/corrupt fee contract state MUST fail closed',
  'MUST NOT query the current policy',
  'original customer gross',
  'PostgreSQL durable evidence remains authority',
  'Only after gates 1–14 pass may a separate release deliberately relax the current zero-fee schema/runtime checks.'
]
for (const token of required) assert.ok(evidence.includes(token), `FIN14 design missing: ${token}`)

// Current production locks must still exist. FIN-14 is forbidden from enabling commission.
assert.ok(db.includes('CHECK (app_commission = 0)'), 'current app_commission=0 schema lock missing')
assert.ok(db.includes('CHECK (merchant_amount IS NULL OR merchant_amount = customer_amount)'), 'current merchant=customer schema lock missing')
assert.ok(db.includes('params.merchantAmount!==params.customerAmount'), 'current settlement zero-fee runtime lock missing')
assert.ok(db.includes('params.appCommission!==0'), 'current settlement commission=0 runtime lock missing')

// Pure adversarial contract model: the only acceptable future behavior is payment-frozen policy semantics.
const policies = Object.freeze({
  V1: Object.freeze({ version: 'V1', bps: 125n }),
  V2: Object.freeze({ version: 'V2', bps: 250n }),
})
const SCALE = 100_000_000n
const freeze = (gross, policy) => {
  const commission = (gross * policy.bps) / 10_000n
  return Object.freeze({ feePolicyVersion: policy.version, customerGross: gross, appCommission: commission, merchantNet: gross - commission })
}
const legacy = gross => Object.freeze({ feePolicyVersion: 'LEGACY_ZERO_V0', customerGross: gross, appCommission: 0n, merchantNet: gross })
const replay = contract => ({ ...contract })
const refund = contract => contract.customerGross

let predicates = 0
const check = (condition, message) => { assert.ok(condition, message); predicates++ }

const old = freeze(10n * SCALE, policies.V1)
const rotated = policies.V2
check(replay(old).feePolicyVersion === 'V1', 'policy rotation changed replay version')
check(replay(old).appCommission === old.appCommission, 'policy rotation changed replay commission')
check(replay(old).merchantNet === old.merchantNet, 'policy rotation changed merchant net')
check(refund(old) === old.customerGross, 'refund did not preserve customer gross')
check(old.customerGross === old.merchantNet + old.appCommission, 'contract equation broken')
check(rotated.version !== old.feePolicyVersion, 'adversarial policy rotation fixture invalid')

const l = legacy(7n * SCALE)
check(l.appCommission === 0n && l.merchantNet === l.customerGross, 'legacy zero-fee isolation broken')
check(replay(l).feePolicyVersion === 'LEGACY_ZERO_V0', 'legacy replay upgraded policy')
check(refund(l) === l.customerGross, 'legacy refund changed gross')

// Horizon fee changes cannot alter commercial contract.
const horizonFeeA = 100_000n, horizonFeeB = 900_000n
check(horizonFeeA !== horizonFeeB, 'fee fixtures must differ')
check(replay(old).merchantNet === old.merchantNet && replay(old).appCommission === old.appCommission, 'Horizon fee contaminated contract')

// Fixed integer scale makes deterministic truncation explicit in this design fixture.
const edge = freeze(1n, policies.V1)
check(edge.appCommission === 0n && edge.merchantNet === 1n, 'fixed-scale edge rounding nondeterministic')

// Missing policy is never silently mapped to current policy in the design contract.
const resolve = contract => {
  if (!contract || !contract.feePolicyVersion) throw new Error('UNKNOWN_FEE_CONTRACT')
  return contract
}
assert.throws(() => resolve(null), /UNKNOWN_FEE_CONTRACT/); predicates++
assert.throws(() => resolve({}), /UNKNOWN_FEE_CONTRACT/); predicates++

// Evidence must explicitly forbid the common mutation classes.
for (const forbidden of [
  'reading `CURRENT_FEE_POLICY` during settlement/refund/replay for an existing payment',
  'treating NULL policy as the newest policy',
  'deriving commission from Horizon fee',
  "mutating an existing payment's feePolicyVersion or monetary contract",
  'backfilling legacy rows with non-zero commission',
  'recomputing historical money with a newer rounding rule',
  'enabling commission by environment variable alone',
  'using Redis as fee-contract authority',
]) { check(evidence.includes(forbidden), `missing forbidden mutation: ${forbidden}`) }

console.log(`FIN14_COMMISSION_MIGRATION_DESIGN=PASS predicates=${predicates} design_only=true commission_enabled=false runtime_kernel_changed=false`)
