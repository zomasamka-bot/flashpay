import "server-only"

import { serverConfig } from "./server-config"

type EvidenceBase = {
  ok: boolean
  action: "pi-pretransaction"
  paymentId: string
  piPaymentId?: string
  financialAuthorityMutated: false
  piMutationExecuted: false
  horizonSubmitExecuted: false
  redisMutated: false
}

type ReadResult = { status: number; evidence: EvidenceBase & Record<string, unknown> }

function base(paymentId: string, piPaymentId?: string): EvidenceBase {
  return {
    ok: false,
    action: "pi-pretransaction",
    paymentId,
    ...(piPaymentId ? { piPaymentId } : {}),
    financialAuthorityMutated: false,
    piMutationExecuted: false,
    horizonSubmitExecuted: false,
    redisMutated: false,
  }
}

export async function readFin4PiPretransactionEvidence(input: { paymentId: string; piPaymentId: string }): Promise<ReadResult> {
  const paymentId = input.paymentId.trim()
  const piPaymentId = input.piPaymentId.trim()
  if (!paymentId || !/^[A-Za-z0-9_-]{8,128}$/.test(piPaymentId)) {
    return { status: 400, evidence: { ...base(paymentId), reason: "INVALID_PI_PAYMENT_ID" } }
  }
  if (!serverConfig.isPiApiKeyConfigured) {
    return { status: 409, evidence: { ...base(paymentId, piPaymentId), reason: "PI_API_UNAVAILABLE" } }
  }

  let response: Response
  try {
    response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(piPaymentId)}`, {
      method: "GET",
      headers: { Authorization: `Key ${serverConfig.piApiKey}`, "Content-Type": "application/json" },
      cache: "no-store",
    })
  } catch {
    return { status: 409, evidence: { ...base(paymentId, piPaymentId), reason: "PI_READ_TRANSPORT_INDETERMINATE" } }
  }
  if (!response.ok) {
    return { status: 409, evidence: { ...base(paymentId, piPaymentId), reason: "PI_READ_NON_OK", piStatus: response.status } }
  }

  const pi = await response.json().catch(() => null)
  const metadataPaymentId = typeof pi?.metadata?.paymentId === "string" ? pi.metadata.paymentId.trim() : ""
  if (metadataPaymentId !== paymentId) {
    return { status: 409, evidence: { ...base(paymentId, piPaymentId), reason: "PI_METADATA_PAYMENT_MISMATCH", exactArmedPayment: false } }
  }

  const transactionTxid = typeof pi?.transaction?.txid === "string" && pi.transaction.txid.trim() ? pi.transaction.txid.trim() : null
  const evidence = {
    ...base(paymentId, piPaymentId),
    ok: true,
    exactArmedPayment: true,
    network: typeof pi?.network === "string" ? pi.network : null,
    direction: typeof pi?.direction === "string" ? pi.direction : null,
    amount: typeof pi?.amount === "number" && Number.isFinite(pi.amount) ? pi.amount : null,
    developerApproved: pi?.status?.developer_approved === true,
    transactionVerified: pi?.status?.transaction_verified === true,
    developerCompleted: pi?.status?.developer_completed === true,
    cancelled: pi?.status?.cancelled === true || pi?.status?.user_cancelled === true,
    transactionPresent: transactionTxid !== null,
    transactionTxid,
  }
  console.log("[FIN-4 R4I PI PRETRANSACTION EVIDENCE]", { ...evidence, transactionTxid: transactionTxid ? "present" : null })
  return { status: 200, evidence }
}
