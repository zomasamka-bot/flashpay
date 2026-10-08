# FIN-11 — Refund Prepared Replay — Final Evidence

Date: 2026-10-08
Scope: certification-only closure. No `app/` or `lib/` runtime change.

## Predicate
A refund that has durable prepared evidence may be replayed only when the exact stored XDR remains bound to the same refund identity, source, destination, amount, hash, and sequence; canonical Horizon evidence proves that the prepared sequence is still next; the durable submit authorization is present; the source-wallet owner is the same refund; opposite Settlement/A2U movement is absent; and replay remains serialized under the source-wallet submit lock.

## Proven source contract
- Fresh refund submission persists prepared XDR/hash/sequence before durable authorization and before Horizon submit.
- Prepared XDR verification reconstructs the signed Pi Testnet transaction and checks exact XDR, transaction hash, sequence, source, destination, native-asset amount, memo/refund payment ID, one operation, and signature.
- Prepared evidence alone does not prove money movement and does not authorize financial action.
- Replay requires `PREPARED_IS_NEXT`; `VERIFIED` is treated as already moved, and all other/uncertain states fail closed.
- Stored-XDR replay re-reads Horizon immediately before submit and requires exact durable submit authorization.
- Replay submits `TransactionBuilder.fromXDR(gate.prepared.envelopeXdr, "Pi Testnet")`; it does not build/sign a new refund transaction.
- Submit success and submit exception both reconcile exact prepared evidence through Horizon before returning confirmed movement.
- Recovery holds the source-wallet submit lock, rejects foreign/stale wallet owners, requires canonical A2U absence, and reconstructs a lost Redis `refund_claim` only after the durable/Pi/Horizon/A2U-absence gate passes.
- A supplied refund authority must exactly match `(paymentId, refundId)`.

## Adversarial certification
`scripts/verify-fin11-refund-prepared-replay.mjs` is mandatory from `scripts/run-financial-recovery-build-verifier.mjs` and asserts the production-source ordering and barriers above. Mutation-sensitive predicates cover exact XDR, hash, sequence, destination, amount, PREPARED_IS_NEXT, durable authorization, source-wallet lock, opposite A2U absence, and foreign wallet owner rejection.

## Financial invariants
- Stored XDR only; no re-sign/rebuild replay.
- Horizon movement truth.
- Settlement XOR Refund / opposite movement barrier.
- Single-wallet serialization.
- Redis is coordination/projection, never financial truth.
- Unknown, stale, foreign, mismatched, or ambiguous evidence fails closed.

## Verdict
`FIN-11 SOURCE CERTIFICATION = PASS / NO RUNTIME PATCH`

Final FIN-11 closure requires the mandatory verifier and Next.js build to pass on the published exact source SHA. Runtime financial semantics are unchanged.
