import "server-only"

const HORIZON_BASE_URL = "https://api.testnet.minepi.com"

type SettlementSubmitHorizonReadResult =
  | Readonly<{
      authorizesFinancialAction: false
      outcome: "READ"
      source: "HORIZON_TX_OPS"
      preparedHash: string
      preparedSequence: string
      fromAddress: string
      transaction: unknown
      operations: unknown[]
    }>
  | Readonly<{
      authorizesFinancialAction: false
      outcome: "HASH_NOT_FOUND"
      preparedHash: string
      preparedSequence: string
      fromAddress: string
      observedSourceSequence: string
    }>
  | Readonly<{
      authorizesFinancialAction: false
      outcome: "INDETERMINATE"
    }>

export async function readSettlementSubmitHorizonEvidence(
  preparedHash: string,
  preparedSequence: string,
  fromAddress: string,
): Promise<SettlementSubmitHorizonReadResult> {
  if (
    !/^[0-9a-f]{64}$/.test(preparedHash) ||
    !/^[1-9][0-9]*$/.test(preparedSequence) ||
    typeof fromAddress !== "string" ||
    !fromAddress.trim() ||
    fromAddress !== fromAddress.trim()
  ) {
    return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }
  }

  const headers = { Accept: "application/json" }
  let transactionResponse: Response
  try {
    transactionResponse = await fetch(`${HORIZON_BASE_URL}/transactions/${preparedHash}`, {
      headers,
      cache: "no-store",
    })
  } catch {
    return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }
  }

  if (transactionResponse.status === 404) {
    let accountResponse: Response
    try {
      accountResponse = await fetch(`${HORIZON_BASE_URL}/accounts/${encodeURIComponent(fromAddress)}`, {
        headers,
        cache: "no-store",
      })
    } catch {
      return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }
    }
    if (!accountResponse.ok) return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }

    let account: unknown
    try {
      account = await accountResponse.json()
    } catch {
      return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }
    }
    if (
      typeof account !== "object" ||
      account === null ||
      !("sequence" in account) ||
      typeof account.sequence !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(account.sequence)
    ) {
      return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }
    }
    return {
      authorizesFinancialAction: false,
      outcome: "HASH_NOT_FOUND",
      preparedHash,
      preparedSequence,
      fromAddress,
      observedSourceSequence: account.sequence,
    }
  }

  if (!transactionResponse.ok) return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }

  let transaction: unknown
  try {
    transaction = await transactionResponse.json()
  } catch {
    return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }
  }

  let operationsResponse: Response
  try {
    operationsResponse = await fetch(`${HORIZON_BASE_URL}/transactions/${preparedHash}/operations`, {
      headers,
      cache: "no-store",
    })
  } catch {
    return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }
  }
  if (!operationsResponse.ok) return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }

  let operationsBody: unknown
  try {
    operationsBody = await operationsResponse.json()
  } catch {
    return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }
  }
  if (
    typeof operationsBody !== "object" ||
    operationsBody === null ||
    !("_embedded" in operationsBody) ||
    typeof operationsBody._embedded !== "object" ||
    operationsBody._embedded === null ||
    !("records" in operationsBody._embedded) ||
    !Array.isArray(operationsBody._embedded.records)
  ) {
    return { authorizesFinancialAction: false, outcome: "INDETERMINATE" }
  }

  return {
    authorizesFinancialAction: false,
    outcome: "READ",
    source: "HORIZON_TX_OPS",
    preparedHash,
    preparedSequence,
    fromAddress,
    transaction,
    operations: operationsBody._embedded.records,
  }
}

export type { SettlementSubmitHorizonReadResult }
