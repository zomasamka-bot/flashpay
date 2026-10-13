# R41-02 atomic candidate — NOT FOR DEPLOY

Source: user-uploaded RXOR03 ZIP, SHA256 ce12cd98f28ded1f5a945ed2110c92e89fae8e3e07e2f3a2cc471185ca937e43.

Changes:
1. `lib/refund-checkpoint-store.ts`: once audited PostgreSQL commit succeeds, Redis mirror failure is logged rather than misreported as durable failure. PostgreSQL and audit exceptions are not swallowed.
2. `lib/a2u-recovery-service.ts`: reject redis SET NX readback with mismatched durable financial fields or any refund markers, rather than accepting identity-only stale values. Does not close all races in recovery's Redis-existing path.
3. `lib/a2u-locked-executor.ts`: denied operation lock returns retryable HTTP 409 instead of building possibly stale final-success response from Redis. Caller/API compatibility needs verification.
4. Two static financial verifiers updated to require stronger refund authority predicate including `manual_review_required`; runtime db.ts unchanged.

Validation: complete `node scripts/run-financial-recovery-build-verifier.mjs` PASS after updating stale assertions. Full `next build` NOT RUN: dependencies/node_modules absent in this offline environment. Real database, Redis, Pi/Horizon, live race and end-to-end regression NOT RUN.

This candidate is NOT certified for production deployment. Do not publish to Vercel until full dependency install, Next build, integration and API contract tests pass. No claim of zero errors or full financial certification.
