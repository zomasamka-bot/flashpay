// Error presentation only. No response here retires or replaces a create intent.
export async function readCreatePaymentFailure(response: Response): Promise<{code:string;error:string;paymentId?:string}> {
  let value: unknown
  try { value = await response.json() } catch { /* HTML, empty and interrupted replies remain unresolved. */ }
  const body = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string,unknown> : {}
  const code = typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(body.code)
    ? body.code : response.status === 403 ? 'CREATE_ACCESS_BLOCKED' : 'CREATE_RESULT_UNCERTAIN'
  const paymentId = typeof body.paymentId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.paymentId)
    ? body.paymentId : undefined
  const message = code === 'CREATE_ACCESS_BLOCKED'
    ? 'Payment creation is blocked by access controls. Your saved request is retained. Retry that same request after service is restored.'
    : code === 'TESTNET_INGRESS_HELD'
      ? 'Testnet payment admission is not enabled. Your saved request is retained; no new QR is available yet.'
      : code === 'CREATE_INTENT_RECOVERY_REQUIRED'
        ? `Payment ${paymentId || ''} already exists but needs recovery. Do not create another payment.`
        : code === 'CREATE_INTENT_CONFLICT'
          ? 'Payment request identity conflicts with existing data. Creation blocked.'
          : `Payment creation not confirmed (${code}). Retry the original request; do not start a new one.`
  return {code,error:message,...(paymentId ? {paymentId} : {})}
}
