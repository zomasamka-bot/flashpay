import type { RefundPresentation } from "./types"

export type CustomerRefundPresentationClientResult =
  | { outcome: "FOUND"; presentation: RefundPresentation }
  | { outcome: "UNAUTHORIZED" }
  | { outcome: "FORBIDDEN" }
  | { outcome: "NOT_FOUND" }
  | { outcome: "INDETERMINATE" }

export async function readCustomerRefundPresentationClient(
  paymentId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<CustomerRefundPresentationClientResult> {
  try {
    const response = await fetch(
      `/api/refunds/customer-status?paymentId=${encodeURIComponent(paymentId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
        signal,
      },
    )

    if (response.status === 401) return { outcome: "UNAUTHORIZED" }
    if (response.status === 403) return { outcome: "FORBIDDEN" }
    if (response.status === 404) return { outcome: "NOT_FOUND" }
    if (!response.ok) return { outcome: "INDETERMINATE" }

    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { outcome: "INDETERMINATE" }
    }
    const result = body as Record<string, unknown>
    if (result.outcome !== "FOUND" || typeof result.presentation !== "object" || result.presentation === null || Array.isArray(result.presentation)) {
      return { outcome: "INDETERMINATE" }
    }

    const presentation = result.presentation as Record<string, unknown>
    if (
      typeof presentation.paymentId !== "string" ||
      presentation.paymentId.trim() === "" ||
      typeof presentation.refundId !== "string" ||
      presentation.refundId.trim() === "" ||
      presentation.paymentId !== paymentId ||
      typeof presentation.amount !== "number" ||
      !Number.isFinite(presentation.amount) ||
      typeof presentation.state !== "string" ||
      typeof presentation.customerStatus !== "string"
    ) {
      return { outcome: "INDETERMINATE" }
    }

    return { outcome: "FOUND", presentation: result.presentation as RefundPresentation }
  } catch {
    return { outcome: "INDETERMINATE" }
  }
}
