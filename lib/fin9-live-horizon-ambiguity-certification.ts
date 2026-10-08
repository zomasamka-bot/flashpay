import "server-only"

export type Fin9HorizonAmbiguityStage = "horizon_submit_post_response_lost"

/**
 * FIN-9 LIVE certification hook.
 *
 * Simulates a lost Horizon submit response only after Horizon has returned from the
 * real submit call and before FlashPay consumes that result as settlement truth.
 * It is armed only for one exact server-side fixture identity and cannot be enabled
 * by amount alone. The existing catch path must reconcile the durable prepared
 * hash/XDR/sequence against canonical Horizon truth and must never blind-resubmit.
 *
 * Scope is intentionally distinct from DR11 (0.10 Pi refund certification) and
 * FIN-8 (0.20 Pi Pi-POST ambiguity certification).
 */
export function shouldInjectFin9AmbiguousHorizonSubmit(input: {
  stage: Fin9HorizonAmbiguityStage
  paymentId: string
  network: unknown
  amount: unknown
}): boolean {
  const armedPaymentId = process.env.FLASHPAY_FIN9_LIVE_PAYMENT_ID
  return (
    process.env.VERCEL_ENV === "production" &&
    typeof armedPaymentId === "string" &&
    armedPaymentId.length > 0 &&
    armedPaymentId === armedPaymentId.trim() &&
    input.paymentId === armedPaymentId &&
    input.network === "Pi Testnet" &&
    input.amount === 0.3 &&
    input.stage === "horizon_submit_post_response_lost"
  )
}
