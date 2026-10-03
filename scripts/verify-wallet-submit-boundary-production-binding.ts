import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
function read(p:string){return readFileSync(resolve(process.cwd(),p),'utf8')}
function assert(c:unknown,m:string):asserts c{if(!c)throw new Error(`WALLET_SUBMIT_BOUNDARY_PRODUCTION_BINDING=FAIL ${m}`)}
function idx(s:string,n:string,l:string){const i=s.indexOf(n);assert(i>=0,`missing ${l}`);return i}
function fn(s:string,startNeedle:string,endNeedle:string,label:string){const a=idx(s,startNeedle,label);const rel=s.slice(a).indexOf(endNeedle);assert(rel>0,`cannot bound ${label}`);return s.slice(a,a+rel)}
const lock=read('lib/pi-wallet-submit-lock.ts')
const refund=read('lib/refund-blockchain-submit.ts')
const settlement=read('lib/a2u-executor.ts')
// A. Lease acquisition and token-safe mutation are production implementation, not a model.
assert(lock.includes('redis.set(key, token, { nx: true, ex: SUBMIT_LOCK_TTL_SECONDS })'),'wallet acquire is not NX+EX token lease')
assert(lock.includes('if current ~= ARGV[1] then return 0 end') && lock.includes('EXPIRE'), 'renew is not token-matched')
assert(lock.includes('if current == ARGV[1] then') && lock.includes('redis.call("DEL", KEYS[1])'),'release is not token-matched')
assert(lock.includes('if (renewed !== 1)') && lock.includes('clearInterval(renewalTimer)'),'lost lease does not stop renewal')
assert(lock.includes('claimed = await claimPiWalletIntent(sourceAddress, owner)'),'submit lock is not coupled to durable wallet intent claim')
// B. Fresh Refund: durable prepared must precede durable authorization, which must precede the one submit.
const freshStart=idx(refund,'export async function submitRefundBlockchainOnce','fresh refund submit'); const freshEnd=idx(refund.slice(freshStart),'\n}\n','fresh refund end')+freshStart; const fresh=refund.slice(freshStart,freshEnd)
const prepared=idx(fresh,'await ensureRefundPreparedSubmit','refund durable prepared')
const auth=idx(fresh,'await authorizeRefundBlockchainSubmit','refund pre-submit authorization')
const submit=idx(fresh,'await server.submitTransaction(transaction)','refund blockchain submit')
assert(prepared < auth && auth < submit,'fresh Refund order is not prepared -> authorization -> submit')
assert((fresh.match(/server\.submitTransaction\(transaction\)/g)||[]).length===1,'fresh Refund contains more than one submit call')
const catchAtRel=fresh.slice(submit).indexOf('} catch (error) {'); assert(catchAtRel>=0,'missing fresh Refund submit catch'); const catchAt=submit+catchAtRel
assert(catchAt>submit,'fresh Refund catch is not after submit')
const catchBody=fresh.slice(catchAt)
assert(catchBody.includes('readRefundPreparedRecoveryEvidence'),'fresh Refund ambiguity does not reconcile exact prepared evidence')
assert(!catchBody.includes('server.submitTransaction(transaction)'),'fresh Refund ambiguity branch blindly resubmits')
// C. Exact Refund replay: existing durable authorization + exact wallet intent before the one replay submit; catch reconciles, never resubmits.
const replayStart=idx(refund,'export async function submitRefundPreparedStoredXdrOnce','refund exact replay'); const replayEnd=idx(refund.slice(replayStart),'\n}\n\nexport async function submitRefundBlockchainOnce','refund replay end')+replayStart; const replay=refund.slice(replayStart,replayEnd)
const intent=idx(replay,'await readPiWalletIntent','refund replay wallet intent')
const authRead=idx(replay,'await readRefundBlockchainSubmitAuthorizationState','refund replay authorization')
const replaySubmit=idx(replay,'await server.submitTransaction(transaction)','refund replay submit')
assert(intent < authRead && authRead < replaySubmit,'refund replay order is not intent -> authorization -> submit')
assert((replay.match(/server\.submitTransaction\(transaction\)/g)||[]).length===1,'refund replay contains more than one submit call')
const replayCatchRel=replay.slice(replaySubmit).indexOf('} catch (error) {'); assert(replayCatchRel>=0,'missing refund replay catch'); const replayCatch=replaySubmit+replayCatchRel
const replayCatchBody=replay.slice(replayCatch)
assert(replayCatchBody.includes('readRefundPreparedRecoveryEvidence'),'refund replay ambiguity does not reconcile')
assert(!replayCatchBody.includes('server.submitTransaction(transaction)'),'refund replay ambiguity blindly resubmits')
// D. Settlement: wallet intent submit lock must be acquired before prepare/submit. Submit exception must reconcile exact prepared transaction and fail closed if not MOVEMENT_VERIFIED.
const stageStart=idx(settlement,'async function stage2SignAndSubmit','Settlement stage2'); const stageEnd=idx(settlement.slice(stageStart),'\n\n/**\n * STAGE 3','Settlement stage2 end')+stageStart; const stage=settlement.slice(stageStart,stageEnd)
const acquire=idx(stage,'await acquirePiWalletIntentSubmitLock','Settlement wallet intent lock')
const prepareStage=idx(stage,'await prepareStage2UnderHeldWalletLock','Settlement prepare under lock')
const move=idx(stage,'await moveStage2UnderHeldWalletLock','Settlement submit move')
assert(acquire < prepareStage && prepareStage < move,'Settlement order is not wallet ownership -> prepare -> submit')
const moveCatchRel=stage.slice(move).indexOf('} catch (submitError) {'); assert(moveCatchRel>=0,'missing Settlement submit ambiguity catch'); const moveCatch=move+moveCatchRel
assert(moveCatch>move,'Settlement ambiguity catch is not after submit')
const moveCatchBody=stage.slice(moveCatch)
assert(moveCatchBody.includes('executeFinancialRecoverySettlementSubmitReplay'),'Settlement ambiguity does not invoke exact recovery reconciliation')
assert(moveCatchBody.includes('reconciled.outcome !== "MOVEMENT_VERIFIED"'),'Settlement ambiguity lacks exact movement proof gate')
assert(moveCatchBody.includes('return { ok: false, error: "Horizon submit outcome remains unverified", userFacingStatus: "settlement_pending" }'),'Settlement unresolved ambiguity does not fail closed')
// E. Low-level Settlement move has exactly one submit call; replay orchestration is read/reconcile-only and does not submit.
const moveFnStart=idx(settlement,'async function moveStage2UnderHeldWalletLock','Settlement low-level move'); const moveFnEnd=idx(settlement.slice(moveFnStart),'\n}\n\ntype Stage2FinalizeResult','Settlement low-level move end')+moveFnStart; const moveFn=settlement.slice(moveFnStart,moveFnEnd)
assert((moveFn.match(/submitTransaction\(transaction\)/g)||[]).length===1,'Settlement low-level move has non-single submit')
const replayOrch=read('lib/financial-recovery-settlement-submit-replay-orchestration.ts')
assert(!replayOrch.includes('submitTransaction('),'Settlement ambiguity reconciliation orchestration can submit')
console.log('WALLET_SUBMIT_BOUNDARY_PRODUCTION_BINDING=PASS boundaries=5 source=production')
