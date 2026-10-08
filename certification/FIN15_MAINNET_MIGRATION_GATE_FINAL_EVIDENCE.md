# FIN-15 — Mainnet Migration Gate — Final Design Evidence
Date: 2026-10-08
Baseline production SHA inspected: 8775afd949d6f17ecb093d955b6f635f5618ffb8

## Verdict
FIN-15 migration-gate design is PASS. This stage does NOT enable Mainnet and does not change runtime, schema, dependencies, wallets, secrets, Pi endpoints, Horizon endpoints, XDR passphrase, settlement, refund, accounting, recovery, or finality behavior.
Current production remains Pi Testnet only.

## Current fail-closed Testnet boundary
- U2A approve rejects canonical Pi payments unless `network === "Pi Testnet"` before durable financial promotion and repeats the network check after Pi refetch.
- U2A complete rejects non-Testnet canonical Pi payments and repeats the check after completion/refetch.
- Settlement XDR verification parses with the `Pi Testnet` network passphrase.
- Settlement Horizon reconciliation reads `https://api.testnet.minepi.com`.
- Refund Horizon evidence and submission use `https://api.testnet.minepi.com`.
- Refund prepared XDR is parsed as `Pi Testnet`.
- Refund Pi reconciliation requires `network === "Pi Testnet"`.
- Existing DR11 production certification remains explicitly scoped to Pi Testnet.
These are safety boundaries. FIN-15 does not weaken or parameterize them.

## Future Mainnet migration contract
Mainnet may be considered only in a separate release after every gate below is proven together. A URL, secret, wallet, SDK, or environment-variable switch alone is never sufficient.

### G1 — Immutable network identity
Every newly created durable payment identity MUST freeze a canonical `networkProfileVersion` and `networkId`.
Network identity MUST propagate unchanged through payment identity, U2A evidence, settlement checkpoint, prepared XDR identity, receipt/finality evidence, refund checkpoint, refund accounting, audit evidence, and recovery.
Missing, unknown, conflicting, or mixed network identity MUST fail closed.

### G2 — Legacy compatibility
All pre-migration financial identities MUST be classified explicitly as Testnet legacy.
Legacy rows MUST NOT inherit a current/default Mainnet profile from configuration.
A legacy payment can only replay/recover/refund under its original Testnet financial domain.

### G3 — Atomic network profile
A network profile is an indivisible contract containing at least Pi canonical network identity/API behavior, Horizon base URL, network passphrase, source wallet identity, network-scoped credentials, XDR signing/verification domain, and allowed ingress/egress directions.
Partial profile activation is forbidden.

### G4 — Wallet and secret separation
Testnet and Mainnet source wallets and credentials MUST be distinct, explicitly network-scoped, least-privilege, and independently rotatable.
No fallback between Mainnet and Testnet secrets is allowed. Logs/evidence MUST never persist private keys or API secrets.

### G5 — Ingress canonicality
Pi identity/payment lookup/approve/complete/cancel/A2U creation MUST reconcile against frozen network identity before financial authority advances.
Client claims, Redis values, request metadata, or environment defaults cannot establish network truth.

### G6 — Settlement XDR and Horizon
Prepared settlement XDR MUST be constructed, hashed, signed, persisted, parsed, reconciled, and submitted under the same frozen network profile.
Passphrase, Horizon, source-wallet, or sequence-domain mismatch MUST block submission. Stored signed XDR remains the only replayable settlement envelope.

### G7 — Refund domain
Refund creation, prepared XDR, Horizon evidence, submit, Pi completion, accounting, and replay MUST use the source payment's frozen network identity.
Cross-network refunds are forbidden. Stored prepared refund XDR remains the only replayable refund envelope.

### G8 — XOR and accounting
Settlement XOR Refund remains network-local and globally unique by durable payment identity.
Receipts, merchant balances, refund accounting, and finality MUST reconcile without mixing Testnet and Mainnet evidence.
Horizon fees remain execution evidence for the same network profile.

### G9 — Recovery and ambiguity
All one-shot claims, reconcile-first rules, wallet exclusion, prepared-XDR replay, Pi mutation ambiguity, Horizon ambiguity, and crash-window rules MUST be re-certified independently on Mainnet-capable source.
Unknown network state is INDETERMINATE/CONFLICT, never retry authorization.

### G10 — Redis and projections
Redis remains projection/coordination only.
Loss of Redis MUST reconstruct network-scoped work from PostgreSQL durable identity without changing network profile or authorizing cross-network work.

### G11 — Release activation gate
Mainnet enablement requires a distinct release with additive schema and explicit legacy Testnet backfill; 100% durable network-identity reconciliation; network-profile mutation certification; Testnet regression; controlled bounded Mainnet certification; settlement/refund/accounting/recovery evidence; rollback drill; and Git/ZIP/Vercel correspondence plus release hygiene.
Until every item passes, Mainnet ingress MUST remain disabled.

### G12 — Rollback semantics
Rollback may stop NEW Mainnet ingress.
It MUST NOT reinterpret, delete, or silently move already-owned Mainnet financial lifecycles to Testnet.
Existing owned work must reconcile under its frozen profile or fail closed for manual resolution.

## Explicitly forbidden shortcuts
Replacing only Horizon URL, Pi credentials, or wallet secret; deriving network from current environment during replay; NULL-to-current network fallback; client/Redis network authority; parsing stored XDR with another passphrase; cross-network settlement/refund replay; mixed-network accounting without durable identity; or enabling Mainnet before bounded live certification and rollback proof.

## Runtime impact
- Mainnet enabled: NO
- Testnet boundary changed: NO
- Runtime financial kernel changed: NO
- Schema changed: NO
- Dependencies changed: NO
- Wallets/secrets changed: NO
- Production endpoints changed: NO

## Closure predicate
FIN-15 closes as DESIGN-ONLY when current Testnet-only source boundaries are proven, future activation requires immutable durable network identity across the full lifecycle, mixed/unknown/defaulted states fail closed, full settlement/refund/accounting/recovery/rollback gates are explicit, and FIN-15 itself enables no Mainnet behavior.
