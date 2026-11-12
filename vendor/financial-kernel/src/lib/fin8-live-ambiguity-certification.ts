import "server-only"

export type Fin8AmbiguityStage = "approve_post_response_lost" | "complete_post_response_lost"

/**
 * FIN-8 permanent LIVE certification hook.
 *
 * This hook intentionally simulates a lost Pi Platform POST response only for one
 * explicitly armed FlashPay payment identity. It is NOT amount-wide authority.
 * All predicates must match: Vercel production, Pi Testnet, exact 0.20 Pi, and the
 * server-only FLASHPAY_FIN8_LIVE_PAYMENT_ID environment value.
 *
 * The hook is placed after the external Pi POST returns but before FlashPay consumes
 * that response or performs canonical GET reconciliation. Durable FIN7 one-shot
 * attempt authority is therefore already consumed, so replay/recovery must reconcile
 * Pi truth and can never use this hook to authorize a second financial POST.
 *
 * DR11's permanent 0.10 Pi automatic-refund certification hook is separate and is
 * intentionally untouched by FIN-8.
 */
export function shouldInjectFin8AmbiguousPiPost(input: {
  stage: Fin8AmbiguityStage
  paymentId: string
  network: unknown
  amount: unknown
}): boolean {
  const armedPaymentId = process.env.FLASHPAY_FIN8_LIVE_PAYMENT_ID
  return (
    process.env.VERCEL_ENV === "production" &&
    typeof armedPaymentId === "string" &&
    armedPaymentId.length > 0 &&
    armedPaymentId === armedPaymentId.trim() &&
    input.paymentId === armedPaymentId &&
    input.network === "Pi Testnet" &&
    input.amount === 0.2 &&
    (input.stage === "approve_post_response_lost" || input.stage === "complete_post_response_lost")
  )
}
