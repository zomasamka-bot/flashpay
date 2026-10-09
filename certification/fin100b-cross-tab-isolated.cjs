// FIN-100B: actual client code in isolated per-tab VM contexts, shared storage,
// modeled exclusive origin-wide Web Locks. No HTTP / database / Pi writes.
const fs = require('node:fs')
const vm = require('node:vm')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
let ts
try { ts = require('typescript') } catch {
  ts = require(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'typescript'))
}
const source = fs.readFileSync(path.join(__dirname, '../lib/create-intent-client.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const data = new Map()
let tail = Promise.resolve()
let issued = 0
const locks = { request(name, options, callback) {
  assert.equal(name, 'flashpay:create-intent:v1')
  assert.equal(options.mode, 'exclusive')
  const next = tail.then(callback)
  tail = next.then(() => {}, () => {})
  return next
} }
function tab(withLocks = true) {
  const localStorage = {
    getItem(k) { return data.get(k) ?? null },
    setItem(k, v) { data.set(k, v) },
    removeItem(k) { data.delete(k) }
  }
  const sandbox = { exports: {}, window: { navigator: withLocks ? { locks } : {}, localStorage, crypto: { randomUUID() { issued++; return crypto.randomUUID() } } } }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return sandbox.exports
}
const acquire = t => t.acquireCreateIntent('uid', 'merchant', 1, '')
;(async () => {
  const a = tab(), b = tab(), staleNeverStarted = tab()
  const [idA, idB] = await Promise.all([acquire(a), acquire(b)])
  assert.equal(idA, idB); assert.equal(issued, 1)
  console.log('TWO_TAB_SAME_INTENT: PASS')
  assert.equal(await acquire(tab()), idA)
  console.log('REFRESH_RECOVERY: PASS')
  await assert.rejects(() => b.acquireCreateIntent('uid', 'merchant', 2, ''))
  await assert.rejects(() => b.acquireCreateIntent('other', 'merchant', 1, ''))
  await assert.rejects(() => acquire(tab(false)))
  console.log('IDENTITY_AND_BROWSER_GUARDS: PASS')
  await a.finishCreateIntent(idA)
  await b.finishCreateIntent(idA)
  await assert.rejects(() => acquire(b), /Previous payment request completed/)
  assert.equal(issued, 1)
  console.log('LATE_TAB_AFTER_FINISH_BLOCKED: PASS')
  await a.beginNextCustomerIntent() // automatic or manual Next Customer
  await assert.rejects(() => acquire(b), /Another tab advanced/)
  await assert.rejects(() => acquire(staleNeverStarted), /Another tab advanced/)
  await assert.rejects(() => b.beginNextCustomerIntent(), /Another tab advanced/)
  assert.equal(issued, 1)
  console.log('STALE_TAB_AFTER_AUTO_NEXT_CUSTOMER: PASS')
  const independent = await acquire(a)
  assert.notEqual(independent, idA); assert.equal(issued, 2)
  console.log('SAME_MERCHANT_EXPLICIT_NEXT_CUSTOMER: PASS')
  const newTab = tab()
  assert.equal(await acquire(newTab), independent)
  await a.finishCreateIntent(independent)
  await a.beginNextCustomerIntent()
  const third = await acquire(a)
  assert.notEqual(third, independent); assert.equal(issued, 3)
  console.log('REPEATED_INTENTIONAL_NEW_PAYMENTS: PASS')
  await assert.rejects(() => acquire(newTab), /Another tab advanced/)
  await assert.rejects(() => newTab.finishCreateIntent(independent), /Another tab advanced/)
  await assert.rejects(() => a.beginNextCustomerIntent(), /unresolved/)
  console.log('OLD_TAB_AND_UNRESOLVED_GUARDS: PASS')
  console.log('ISOLATED_CROSS_TAB_TEST: PASS')
  console.log('PRODUCTION_WRITES: ZERO')
})().catch(error => { console.error('ISOLATED_CROSS_TAB_TEST: FAIL', error); process.exitCode = 1 })
