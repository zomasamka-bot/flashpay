import "server-only"

import { serverConfig } from "@/lib/server-config"
import { readFin4SameWalletSubmitCandidates, type Fin4DurableCandidate } from "@/lib/fin4-submit-candidate-reader"

type RecordLike = Record<string, unknown>
function isRecord(v: unknown): v is RecordLike { return typeof v === "object" && v !== null && !Array.isArray(v) }
function exactString(v: unknown): string | null { return typeof v === "string" && v.trim() !== "" && v === v.trim() ? v : null }

type HorizonAbsence = { outcome: "ABSENT" } | { outcome: "MOVEMENT_PRESENT" | "INDETERMINATE"; reason: string }

async function proveA2UHorizonAbsence(pi: RecordLike, a2uPaymentId: string): Promise<HorizonAbsence> {
  const source = exactString(pi.from_address)
  const createdRaw = exactString(pi.created_at)
  const created = createdRaw === null ? NaN : Date.parse(createdRaw)
  if (source === null || !/^G[A-Z2-7]{55}$/.test(source) || !Number.isFinite(created)) return { outcome: "INDETERMINATE", reason: "PI_SOURCE_OR_TIME_INVALID" }
  const stopBefore = created - 5 * 60 * 1000
  let url = `https://api.testnet.minepi.com/accounts/${encodeURIComponent(source)}/transactions?order=desc&limit=200&include_failed=true`
  for (let page = 0; page < 20; page++) {
    let response: Response
    try { response = await fetch(url, { cache: "no-store" }) } catch { return { outcome: "INDETERMINATE", reason: "HORIZON_READ_FAILED" } }
    if (!response.ok) return { outcome: "INDETERMINATE", reason: `HORIZON_HTTP_${response.status}` }
    const body: unknown = await response.json().catch(() => null)
    if (!isRecord(body) || !isRecord(body._embedded) || !Array.isArray(body._embedded.records)) return { outcome: "INDETERMINATE", reason: "HORIZON_SHAPE_INVALID" }
    const records = body._embedded.records
    if (records.some((tx) => isRecord(tx) && tx.successful === true && tx.memo_type === "text" && tx.memo === a2uPaymentId)) return { outcome: "MOVEMENT_PRESENT", reason: "HORIZON_MEMO_MOVEMENT_PRESENT" }
    if (records.length === 0) return { outcome: "ABSENT" }
    const last = records[records.length - 1]
    const oldestRaw = isRecord(last) ? exactString(last.created_at) : null
    const oldest = oldestRaw === null ? NaN : Date.parse(oldestRaw)
    if (Number.isFinite(oldest) && oldest <= stopBefore) return { outcome: "ABSENT" }
    const next = isRecord(body._links) && isRecord(body._links.next) ? exactString(body._links.next.href) : null
    if (next === null || !next.startsWith("https://api.testnet.minepi.com/")) return { outcome: "INDETERMINATE", reason: "HORIZON_PAGINATION_INVALID" }
    url = next
  }
  return { outcome: "INDETERMINATE", reason: "HORIZON_SCAN_BOUND_EXHAUSTED" }
}

function exactPiCandidate(pi: RecordLike, candidate: Fin4DurableCandidate, sourceWallet: string): { ok: true } | { ok: false; reason: string } {
  if (candidate.a2uPaymentId === null || candidate.merchantUid === null || candidate.customerAmount === null) return { ok: false, reason: "DURABLE_IDENTITY_INCOMPLETE" }
  if (pi.identifier !== candidate.a2uPaymentId) return { ok: false, reason: "PI_IDENTIFIER_MISMATCH" }
  if (pi.network !== "Pi Testnet" || pi.direction !== "app_to_user") return { ok: false, reason: "PI_NETWORK_OR_DIRECTION_MISMATCH" }
  if (pi.amount !== candidate.customerAmount || pi.user_uid !== candidate.merchantUid) return { ok: false, reason: "PI_AMOUNT_OR_UID_MISMATCH" }
  if (pi.from_address !== sourceWallet) return { ok: false, reason: "PI_SOURCE_WALLET_MISMATCH" }
  if (!isRecord(pi.metadata) || pi.metadata.type !== "a2u_settlement" || pi.metadata.paymentId !== candidate.paymentId) return { ok: false, reason: "PI_METADATA_MISMATCH" }
  if (!isRecord(pi.status)) return { ok: false, reason: "PI_STATUS_INVALID" }
  if (pi.status.cancelled === true || pi.status.user_cancelled === true) return { ok: false, reason: "PI_CANCELLED" }
  if (pi.status.transaction_verified === true || pi.status.developer_completed === true) return { ok: false, reason: "PI_ALREADY_PROGRESSED" }
  if (pi.transaction != null || exactString(pi.txid) !== null || exactString(pi.transaction_id) !== null) return { ok: false, reason: "PI_TRANSACTION_PRESENT" }
  return { ok: true }
}

export async function readFin4QualifiedExistingCandidates(sourceWallet: string) {
  const scan = await readFin4SameWalletSubmitCandidates(sourceWallet)
  if (!scan) return { ok: false as const, outcome: "READ_INDETERMINATE" as const, sourceWallet, financialAuthorityMutated: false, piMutationExecuted: false, horizonSubmitExecuted: false, redisMutated: false }
  if (!serverConfig.isPiApiKeyConfigured) return { ok: false as const, outcome: "READ_INDETERMINATE" as const, sourceWallet, reason: "PI_API_UNAVAILABLE", financialAuthorityMutated: false, piMutationExecuted: false, horizonSubmitExecuted: false, redisMutated: false }

  const eligibleDurable = scan.candidates.filter((c) => c.classification === "PREPARATION_REQUIRED_STAGE1" || c.classification === "SETTLEMENT_SUBMIT_ENTRY_CANDIDATE")
  const results: Array<Record<string, unknown>> = []
  for (const candidate of eligibleDurable) {
    if (candidate.a2uPaymentId === null) { results.push({ paymentId: candidate.paymentId, durableClass: candidate.classification, qualified: false, reason: "DURABLE_IDENTITY_INCOMPLETE" }); continue }
    let response: Response
    try { response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(candidate.a2uPaymentId)}`, { headers: { Authorization: `Key ${serverConfig.piApiKey}` }, cache: "no-store" }) }
    catch { results.push({ paymentId: candidate.paymentId, durableClass: candidate.classification, qualified: false, reason: "PI_READ_FAILED" }); continue }
    if (!response.ok) { results.push({ paymentId: candidate.paymentId, durableClass: candidate.classification, qualified: false, reason: `PI_HTTP_${response.status}` }); continue }
    const pi: unknown = await response.json().catch(() => null)
    if (!isRecord(pi)) { results.push({ paymentId: candidate.paymentId, durableClass: candidate.classification, qualified: false, reason: "PI_SHAPE_INVALID" }); continue }
    const exact = exactPiCandidate(pi, candidate, sourceWallet)
    if (!exact.ok) { results.push({ paymentId: candidate.paymentId, a2uPaymentId: candidate.a2uPaymentId, durableClass: candidate.classification, qualified: false, reason: exact.reason }); continue }
    const horizon = await proveA2UHorizonAbsence(pi, candidate.a2uPaymentId)
    if (horizon.outcome !== "ABSENT") { results.push({ paymentId: candidate.paymentId, a2uPaymentId: candidate.a2uPaymentId, durableClass: candidate.classification, qualified: false, reason: horizon.reason, horizonOutcome: horizon.outcome }); continue }
    results.push({ paymentId: candidate.paymentId, a2uPaymentId: candidate.a2uPaymentId, durableClass: candidate.classification, qualified: true, reason: null, piExact: true, horizonAbsenceProven: true })
  }
  const qualified = results.filter((r) => r.qualified === true)
  return {
    ok: true as const,
    outcome: qualified.length > 0 ? "QUALIFIED_EXISTING_CANDIDATE_FOUND" as const : "NO_SAFE_EXISTING_CANDIDATE" as const,
    sourceWallet,
    durableEligibleCount: eligibleDurable.length,
    qualifiedCount: qualified.length,
    qualifiedPaymentIds: qualified.map((r) => r.paymentId),
    candidates: results,
    financialAuthorityMutated: false,
    piMutationExecuted: false,
    horizonSubmitExecuted: false,
    redisMutated: false,
  }
}
