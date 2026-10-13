// R4 source contract assertion only; NOT an HTTP or financial certification.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(__dirname, '..', 'lib', 'db.ts');
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('export async function recoverInitialPaymentProjectionUnderDurableGuard(');
if (start < 0) throw Error('Recovery guard missing');
const block = source.slice(start, source.indexOf('\n}\n', source.indexOf('  try {', start)) + 3);
for (const table of [
  'refund_checkpoints', 'financial_pi_mutation_attempts',
  'settlement_u2a_approval_retirements',
  'settlement_a2u_stage1_retirements',
  'settlement_a2u_ongoing_observations',
]) {
  if (!block.includes('EXISTS(SELECT 1 FROM ' + table + ' WHERE payment_id=${params.paymentId})')) {
    throw Error('Guard missing table ' + table);
  }
}
for (const field of ['refund','pi_attempt','retired','a2u_stage1_retired','a2u_ongoing_observed']) {
  if (!block.includes('evidence[0].' + field + ' !== false')) throw Error('Guard missing fail-closed check ' + field);
}
if (!block.includes('pg_advisory_xact_lock(') || !block.includes('FOR UPDATE')) throw Error('Lock missing');
if (block.indexOf('return await params.persist()') < block.indexOf('a2u_ongoing_observed !== false')) throw Error('Guard occurs after persist');
console.log('FIN100B_R4_FIVE_DURABLE_EVIDENCE_GUARDS_SOURCE=PASS');
