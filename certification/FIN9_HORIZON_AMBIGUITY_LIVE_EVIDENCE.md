# FIN-9 — Horizon Submit Ambiguity LIVE — READY / OPEN

Prepared: 2026-10-08
Baseline: FIN-7 + FIN-8 FULL PASS evidence-synchronized clean artifact.
LIVE scope: one exact `0.30 Pi` Pi Testnet fixture, armed by server-only `FLASHPAY_FIN9_LIVE_PAYMENT_ID` in Vercel production.

## Objective

Certify the externally ambiguous Horizon submit boundary: Horizon may accept the signed A2U transaction while FlashPay loses the submit response before durable Horizon confirmation. The only safe identity is the already-durable signed XDR/hash/sequence. FIN-9 must prove canonical Horizon reconciliation and no duplicate movement, no re-signing, and no blind retry.

## Source proof before LIVE

- PostgreSQL `prepared` checkpoint containing exact signed envelope XDR, transaction hash and sequence is required before Horizon submit.
- The controlled hook fires only **after** the real Horizon `submitTransaction` returns and before FlashPay consumes that response as settlement truth.
- The submit exception path performs GET/read reconciliation against the exact durable prepared identity and cannot submit again from that branch.
- Exact movement proof binds XDR, hash, sequence, A2U payment identity, source, destination and amount.
- Recovery replay, when separately authorized by all safety gates, parses the **stored signed XDR** with `TransactionBuilder.fromXDR`; it verifies XDR round-trip, hash, sequence and source before submission. It does not rebuild or re-sign a transaction.
- Refund/opposite-finality and sequence gates remain fail-closed; Redis is not financial authority.
- DR11 permanent 0.10 Pi automatic-refund certification remains unchanged. FIN-8 0.20 scope is not reused.

Static certifier:
`FIN9_LIVE_HORIZON_AMBIGUITY_HOOK=PASS scope=production+Pi_Testnet+0.30+exact_payment_id boundary=post_horizon_submit_response_loss prepared=durable_before_submit reconciliation=exact_hash_xdr_sequence replay=exact_stored_xdr_only blind_resubmit=false DR11_0.10=preserved`

## LIVE closure predicates — not yet claimed

FIN-9 remains **OPEN** until one armed production fixture proves all of the following from durable/canonical evidence:

1. Prepared XDR/hash/sequence were durable before submit.
2. Horizon accepted the exact prepared transaction.
3. The controlled response-loss boundary executed.
4. FlashPay reconciled canonical Horizon truth by the exact prepared hash/XDR/sequence.
5. No second prepared identity, new sequence, re-sign, or duplicate payment movement occurred.
6. The exact Horizon fee and movement were durably recorded.
7. Pi completion and DB finality completed deterministically, or uncertainty failed closed without blind retry.
8. Post-test settlement/refund XOR and FIN-6 accounting/finality matrix remain PASS.

No LIVE PASS is asserted by this file before those predicates are captured.
