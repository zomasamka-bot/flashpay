import fs from 'node:fs';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../lib/refund-executor.ts',import.meta.url),'utf8');
const extract=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert(a>=0&&b>a,`missing function boundary ${start}`);return source.slice(a,b)};
const creation=extract('export async function executeRefundCreation(', 'export async function readRefundPreparedReplayUnderExistingOwner(');
const blockchain=extract('export async function executeRefundBlockchain(', 'export async function executeRefundAccounting(');
function ordered(name,code,needles){let previous=-1;for(const n of needles){const pos=code.indexOf(n,previous+1);assert(pos>previous,`${name}: missing/out of order ${n}`);previous=pos;}console.log(`R36_${name}=PASS`)}
ordered('REFUND_CREATE_PRE_SUBMIT_GUARDS',creation,[
 'getRefundCheckpointAuthoritative(refundId)',
 'loadRefundPaymentProjection(checkpoint)',
 'ensurePaymentOperationLock(checkpoint.paymentId, checkpoint.refundId)',
 'reconcileRefundWithPi({',
 'verifyRefundOriginalCustomerBinding({',
 'claimRefundCreateAttempt({',
 "fetch('https://api.minepi.com/v2/payments', { method: 'POST'"
]);
ordered('REFUND_BLOCKCHAIN_PRE_SUBMIT_GUARDS',blockchain,[
 'getRefundCheckpointAuthoritative(refundId)',
 'ensurePaymentOperationLock(checkpoint.paymentId, checkpoint.refundId)',
 'loadRefundPaymentProjection(checkpoint)',
 'reconcileRefundWithPi({',
 'verifyRefundBlockchainEvidence({',
 'readRefundBlockchainSubmissionClaimState(',
 'readRefundPreparedSubmitState(',
 'acquirePiWalletIntentSubmitLock(',
 'beginRefundBlockchainSubmissionClaim(',
 'submitRefundBlockchainOnce({'
]);
for(const [name,code,needle] of [
 ['CREATE_UNKNOWN_RECONCILIATION',creation,"reconciliation.outcome === 'INDETERMINATE'"],
 ['CREATE_ORIGINAL_BINDING',creation,".outcome !== 'VERIFIED'"],
 ['CREATE_ONE_SHOT',creation,"createAttempt.outcome !== 'RECORDED'"],
 ['BLOCKCHAIN_UNCERTAIN_CLAIM',blockchain,"claim.state === 'uncertain'"],
 ['BLOCKCHAIN_UNCERTAIN_PREPARED',blockchain,"prepared?.state === 'uncertain'"],
 ['BLOCKCHAIN_UNCERTAIN_EVIDENCE',blockchain,"evidence.outcome === 'INDETERMINATE'"],
 ['BLOCKCHAIN_OWNER_LOCK',blockchain,"if (!walletLock) return { outcome: 'blocked'"],
 ['BLOCKCHAIN_OWNER_RELEASE',blockchain,'await walletLock.release()']]){
 assert(code.includes(needle),`R36_${name}: guard missing`);console.log(`R36_${name}=PASS`)
}
// Mutation sensitivity: each gate is essential to the verifier's source contract.
const mutation=creation.replace('claimRefundCreateAttempt({','claimRefundCreateAttempt_REMOVED({');
assert(!mutation.includes('claimRefundCreateAttempt({'));
assert.throws(()=>ordered('MUTATION_MUST_FAIL',mutation,['claimRefundCreateAttempt({']));
console.log('R36_REFUND_EXECUTOR_SOURCE_GUARD_MUTATION=PASS');
console.log('R36_REFUND_EXECUTOR_RUNTIME_AND_PI_HORIZON=NOT_TESTED');
