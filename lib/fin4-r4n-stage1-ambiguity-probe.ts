import "server-only"

import { query } from "@/lib/db"
import { redis, isRedisConfigured } from "@/lib/redis"
import { reconcileIncompleteA2UPayment, isPiA2UPayment, isRecord } from "@/lib/pi-reconciliation"

type Row = Record<string, unknown>
function exactString(v: unknown): string | null { return typeof v === "string" && v.trim() !== "" && v === v.trim() ? v : null }
function finite(v: unknown): number | null { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Number.isFinite(n) ? n : null }

async function horizonAbsence(pi: Row, a2uPaymentId: string) {
  const source = exactString(pi.from_address)
  const createdRaw = exactString(pi.created_at)
  const created = createdRaw === null ? NaN : Date.parse(createdRaw)
  if (source === null || !/^G[A-Z2-7]{55}$/.test(source) || !Number.isFinite(created)) return { outcome: "INDETERMINATE", reason: "PI_SOURCE_OR_TIME_INVALID" } as const
  const stopBefore = created - 5 * 60 * 1000
  let url = `https://api.testnet.minepi.com/accounts/${encodeURIComponent(source)}/transactions?order=desc&limit=200&include_failed=true`
  for (let page = 0; page < 20; page++) {
    let response: Response
    try { response = await fetch(url, { cache: "no-store" }) } catch { return { outcome: "INDETERMINATE", reason: "HORIZON_READ_FAILED" } as const }
    if (!response.ok) return { outcome: "INDETERMINATE", reason: `HORIZON_HTTP_${response.status}` } as const
    const body: unknown = await response.json().catch(() => null)
    if (!isRecord(body) || !isRecord(body._embedded) || !Array.isArray(body._embedded.records)) return { outcome: "INDETERMINATE", reason: "HORIZON_SHAPE_INVALID" } as const
    if (body._embedded.records.some((tx) => isRecord(tx) && tx.successful === true && tx.memo_type === "text" && tx.memo === a2uPaymentId)) return { outcome: "MOVEMENT_PRESENT", reason: "HORIZON_MEMO_MOVEMENT_PRESENT" } as const
    if (body._embedded.records.length === 0) return { outcome: "ABSENT", reason: null } as const
    const last = body._embedded.records[body._embedded.records.length - 1]
    const oldestRaw = isRecord(last) ? exactString(last.created_at) : null
    const oldest = oldestRaw === null ? NaN : Date.parse(oldestRaw)
    if (Number.isFinite(oldest) && oldest <= stopBefore) return { outcome: "ABSENT", reason: null } as const
    const next = isRecord(body._links) && isRecord(body._links.next) ? exactString(body._links.next.href) : null
    if (next === null || !next.startsWith("https://api.testnet.minepi.com/")) return { outcome: "INDETERMINATE", reason: "HORIZON_PAGINATION_INVALID" } as const
    url = next
  }
  return { outcome: "INDETERMINATE", reason: "HORIZON_SCAN_BOUND_EXHAUSTED" } as const
}

export async function readFin4R4NStage1Ambiguity(paymentA: string, paymentB: string) {
  const rows = await query(`SELECT payment_id,stage,merchant_id,merchant_uid,customer_amount,merchant_amount,app_commission,u2a_identifier,u2a_txid,a2u_payment_id,a2u_from_address,a2u_to_address,prepared_tx_hash,prepared_sequence,a2u_txid AS movement_txid,horizon_confirmed_at,pi_completed_at,db_finalized_at,updated_at FROM settlement_checkpoints WHERE payment_id IN ($1,$2) ORDER BY payment_id`, [paymentA, paymentB])
  const a = (rows as Row[]).find((r) => r.payment_id === paymentA) ?? null
  const b = (rows as Row[]).find((r) => r.payment_id === paymentB) ?? null
  const amount = a ? finite(a.customer_amount) : null
  const merchantUid = a ? exactString(a.merchant_uid) : null
  const sourceWallet = b ? exactString(b.a2u_from_address) : null
  let redisProjection: unknown = null
  let redisRead = "UNAVAILABLE"
  if (isRedisConfigured) {
    try { redisProjection = await redis.get(`payment:${paymentA}`); redisRead = "READ" } catch { redisRead = "INDETERMINATE" }
  }
  if (!a || !b || amount === null || amount <= 0 || merchantUid === null || sourceWallet === null) return { ok:false as const,outcome:"READ_INDETERMINATE" as const,reason:"DURABLE_INPUT_INCOMPLETE",paymentA,paymentB,durableA:a,durableB:b,redisRead,redisProjection,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false }
  const rec = await reconcileIncompleteA2UPayment(paymentA, amount, merchantUid)
  if (rec.outcome !== "FOUND" || !rec.dto || !isPiA2UPayment(rec.dto)) return { ok:true as const,outcome:rec.outcome,reason:rec.reason,paymentA,paymentB,durableA:a,durableB:b,redisRead,redisProjection,piCandidate:null,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false }
  const pi = rec.dto
  const metadata = isRecord(pi.metadata) ? pi.metadata : null
  const status = isRecord(pi.status) ? pi.status : null
  const transaction = isRecord(pi.transaction) ? pi.transaction : null
  const a2uPaymentId = exactString(pi.identifier)
  const exact = a2uPaymentId !== null && pi.network === "Pi Testnet" && pi.direction === "app_to_user" && pi.amount === amount && pi.user_uid === merchantUid && pi.from_address === sourceWallet && metadata?.type === "a2u_settlement" && metadata?.paymentId === paymentA
  const progressed = pi.cancelled === true || pi.rejected === true || pi.completed === true || status?.cancelled === true || status?.user_cancelled === true || status?.transaction_verified === true || status?.developer_completed === true || transaction?.verified === true || exactString(transaction?.txid) !== null || exactString(pi.txid) !== null || exactString(pi.transaction_id) !== null
  const horizon = exact && a2uPaymentId !== null ? await horizonAbsence(pi, a2uPaymentId) : { outcome:"INDETERMINATE",reason:"PI_IDENTITY_NOT_EXACT" } as const
  return { ok:true as const,outcome: exact && !progressed && horizon.outcome === "ABSENT" ? "EXACT_UNMOVED_A2U_FOUND" as const : "UNSAFE_OR_INDETERMINATE" as const,reason: exact ? (progressed ? "PI_ALREADY_PROGRESSED" : horizon.reason) : "PI_IDENTITY_NOT_EXACT",paymentA,paymentB,durableA:a,durableB:b,redisRead,redisProjection,piCandidate:{identifier:a2uPaymentId,network:pi.network,direction:pi.direction,amount:pi.amount,user_uid:pi.user_uid,from_address:pi.from_address,to_address:pi.to_address,metadata,status,transactionPresent:pi.transaction != null,exactIdentity:exact,progressed},horizonOutcome:horizon.outcome,horizonReason:horizon.reason,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false }
}
