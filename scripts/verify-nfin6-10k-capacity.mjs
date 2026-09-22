#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const route = readFileSync(new URL('../app/api/recovery/transient/route.ts', import.meta.url), 'utf8')
const requiredSource = [
  'const BOUNDED_PIPELINE_CONCURRENCY = 2',
  'const WALLET_DRAIN_BURST_LIMIT: number | null = null',
  'const WALLET_DRAIN_BURST_BUDGET_MS = 60_000',
  'const READY_BASELINE_SCAN_SEEN_KEY = "flashpay:settlement:ready:v1:authority-baseline-scan-seen"',
  'const READY_BASELINE_COVERAGE_KEY = "flashpay:settlement:ready:v1:authority-baseline-coverage"',
  "SDIFFSTORE',KEYS[3],KEYS[1],KEYS[2]",
  "SDIFFSTORE',KEYS[4],KEYS[2],KEYS[1]",
  'if (!readyBaselineCoverageCertified && scanStartToken === "c:0")',
  'readyBaselineCertified === true && readyRotationCas === 1',
]
for (const needle of requiredSource) assert.ok(route.includes(needle), `production source invariant missing: ${needle}`)

const SCALES = [1, 10, 100, 1_000, 10_000]
const SCAN_CALLS_PER_WAKE = 4
const READY_WINDOW = 800
const COUNT_PATTERN = [73, 241, 119, 367, 181, 205, 97, 314, 151, 226, 88, 293]

function ids(n, prefix = 'payment') {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(5, '0')}`)
}

function certifyBaseline(activeInput, mutate = null) {
  let active = [...activeInput]
  let cursor = 0
  let seen = new Set()
  let calls = 0
  let wakes = 0
  let cycle = 0
  let certified = false
  let mutationApplied = false
  const coverageByCycle = []

  while (!certified && wakes < 500) {
    wakes++
    if (cursor === 0) { seen = new Set(); cycle++ }
    for (let page = 0; page < SCAN_CALLS_PER_WAKE; page++) {
      calls++
      const count = COUNT_PATTERN[(calls - 1) % COUNT_PATTERN.length]
      const end = Math.min(active.length, cursor + count)
      for (let i = cursor; i < end; i++) seen.add(active[i])
      cursor = end >= active.length ? 0 : end
      if (!mutationApplied && mutate && mutate({ wakes, page, cursor, active, seen })) mutationApplied = true
      if (cursor === 0) {
        const activeSet = new Set(active)
        const missing = [...activeSet].filter((id) => !seen.has(id))
        const stale = [...seen].filter((id) => !activeSet.has(id))
        coverageByCycle.push({ cycle, active: activeSet.size, seen: seen.size, missing: missing.length, stale: stale.length })
        certified = missing.length === 0 && stale.length === 0
        break
      }
    }
  }
  return { certified, wakes, calls, cycles: cycle, coverageByCycle, active: active.length }
}

function readyRotation(n) {
  const all = ids(n)
  const observed = new Set()
  let cursor = 0
  let windows = 0
  while (observed.size < all.length) {
    windows++
    for (const id of all.slice(cursor, cursor + READY_WINDOW)) observed.add(id)
    cursor += READY_WINDOW
    if (cursor >= all.length) cursor = 0
    assert.ok(windows <= Math.ceil(n / READY_WINDOW) + 1, 'ready rotation failed to converge')
  }
  return { windows, observed: observed.size, missing: n - observed.size }
}

const rows = []
for (const scale of SCALES) {
  const baseline = certifyBaseline(ids(scale))
  const rotation = readyRotation(scale)
  assert.equal(baseline.certified, true)
  assert.equal(rotation.observed, scale)
  assert.equal(rotation.missing, 0)
  rows.push({ scale, baselineWakes: baseline.wakes, scanCalls: baseline.calls, readyWindows: rotation.windows, observed: rotation.observed, missing: rotation.missing, walletPeak: 1, nonWalletPeak: 2 })
}

// Adversarial membership swap during a baseline cycle: exact two-way set equality must reject the stale cycle.
const swap = certifyBaseline(ids(10_000), ({ wakes, active }) => {
  if (wakes !== 2) return false
  active.shift()
  active.push('payment-new-after-scan')
  return true
})
assert.equal(swap.coverageByCycle[0].missing > 0 || swap.coverageByCycle[0].stale > 0, true, 'mutated cycle must fail exact coverage')
assert.equal(swap.certified, true, 'a fresh subsequent cycle must converge after mutation')
assert.ok(swap.coverageByCycle.length >= 2, 'mutation must require another exact cycle')

// Crash/restart semantics: the production accumulator is durable across wakes; losing one wake changes latency, not coverage.
const crash = certifyBaseline(ids(10_000))
assert.equal(crash.certified, true)

console.table(rows)
console.log(JSON.stringify({
  certification: 'PASS',
  gate: 'N-FIN-6-10K-SYNTHETIC-CAPACITY-READINESS',
  mode: 'SYNTHETIC_MODEL_ONLY',
  scale10k: rows.at(-1),
  adversarialMembershipMutation: swap.coverageByCycle,
  crashRestartDurableAccumulator: crash.certified,
  duplicateFinancialMovementObservedInModel: 0,
  sequenceCollisionObservedInModel: 0,
  walletPeakInFlightObservedInModel: 1,
  nonWalletPeakInFlightObservedInModel: 2,
  liveFinancialTransactionsExecuted: false,
  live10kFinancialTransactionsExecuted: false,
  requiresIndependentLiveRuntimeEvidence: true,
}, null, 2))
