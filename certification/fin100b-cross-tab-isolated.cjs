// Isolated certification: executes actual TypeScript client under a modeled
// origin-wide exclusive Web Locks scheduler and shared localStorage.
const fs = require('node:fs')
const vm = require('node:vm')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')
const source = fs.readFileSync('lib/create-intent-client.ts', 'utf8')
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
;(async () => {
  const a = tab(), b = tab()
  const [idA, idB] = await Promise.all([
    a.acquireCreateIntent('uid', 'merchant', 1, ''),
    b.acquireCreateIntent('uid', 'merchant', 1, '')
  ])
  assert.equal(idA, idB)
  assert.equal(issued, 1)
  console.log('TWO_TAB_SAME_INTENT: PASS')
  const refresh = tab()
  assert.equal(await refresh.acquireCreateIntent('uid', 'merchant', 1, ''), idA)
  console.log('REFRESH_RECOVERY: PASS')
  await assert.rejects(() => b.acquireCreateIntent('uid', 'merchant', 2, ''))
  await assert.rejects(() => b.acquireCreateIntent('other', 'merchant', 1, ''))
  console.log('AMOUNT_AND_MERCHANT_GUARDS: PASS')
  await assert.rejects(() => tab(false).acquireCreateIntent('uid', 'merchant', 1, ''))
  console.log('UNSUPPORTED_BROWSER_FAIL_CLOSED: PASS')
  await a.finishCreateIntent(idA)
  await b.finishCreateIntent(idA) // idempotent acknowledgment across tabs
  const fresh = await b.acquireCreateIntent('uid', 'merchant', 1, '')
  assert.notEqual(fresh, idA)
  assert.equal(issued, 2)
  console.log('SERIALIZED_FINISH_AND_NEW_INTENT: PASS')
  console.log('ISOLATED_CROSS_TAB_TEST: PASS')
  console.log('PRODUCTION_WRITES: ZERO')
})().catch(error => { console.error('ISOLATED_CROSS_TAB_TEST: FAIL', error); process.exitCode = 1 })
