import { readFileSync } from 'node:fs'

const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8')
const route = readFileSync(new URL('../app/api/pi/approve/route.ts', import.meta.url), 'utf8')
const must = (ok, msg) => { if (!ok) throw new Error(`FIN7-S2 verifier failed: ${msg}`) }

must(db.includes('u2a_approval_guard_version TEXT'), 'guard-version schema missing')
must(db.includes('u2a_approval_attempted_at TIMESTAMP'), 'attempt timestamp schema missing')
must(db.includes("u2a_approval_guard_version='fin7_v1',u2a_approval_attempted_at=NULL"), 'new ownership is not version-bound')
must(db.includes('export async function claimSettlementU2AApprovalAttempt'), 'one-shot attempt claim missing')
must(db.includes("u2a_approval_guard_version='fin7_v1' AND u2a_approval_attempted_at IS NULL"), 'attempt claim is not guarded one-shot')
must(db.includes("row.u2a_approval_guard_version !== 'fin7_v1' || row.u2a_approval_attempted_at == null"), 'replay does not require exact durable attempt evidence')
must(route.includes('if (approvalClaim.outcome === "REPLAYED")'), 'ownership replay reconcile-first branch missing')
const replay = route.indexOf('if (approvalClaim.outcome === "REPLAYED")')
const attempt = route.indexOf('const approvalAttempt = await claimSettlementU2AApprovalAttempt')
const post = route.indexOf('`https://api.minepi.com/v2/payments/${identifier}/approve`')
must(replay >= 0 && attempt > replay && post > attempt, 'required ordering replay GET -> durable attempt -> Pi POST violated')
must(route.slice(replay, attempt).includes('developer_approved === true'), 'replay branch does not accept canonical approval proof before POST')
must(route.includes('approvalAttempt.outcome !== "RECORDED"'), 'only first durable attempt may reach POST')
must(route.includes('PI_APPROVAL_ATTEMPT_ALREADY_RECORDED'), 'prior-attempt fail-closed code missing')
console.log('FIN7_U2A_APPROVAL_ONE_SHOT_ATTEMPT=PASS guard=fin7_v1 replay=reconcile_first post=recorded_only')
