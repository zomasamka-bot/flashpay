# FLASHpay — FIN-100B/R32. Wake and historical merchant receipt source patch

Status: SOURCE PATCH CANDIDATE / NOT FULL PRODUCTION RELEASE CERTIFIED
Date: 2026-10-16 (Africa/Cairo)
Baseline local ZIP: FLASHpay_FIN100B_R31_MERCHANT_UI_PATCH_REVIEW_ONLY_2026-10-15.zip
Baseline ZIP SHA-256: ee630402005d487498437e7e8dcf2fb42238d22bce59ed5653947ee0dcf2547a
Last verified pre-patch production: Git ffa8e9430f835166855ce1066642e94fe26b3c37, Vercel dpl_fNJfWoopWyQ384u8riBUG3T5T466 READY.
Compared historical production: d6c747304dd59bd85c7ad6d26f290df42d5d04df; seven commits between that baseline and current, changes concentrated in history, recovery, and merchant UI. The receipt API/UI source was not changed by those seven commits; the newer Redis-history certification logic can nevertheless affect its legacy lookup path. Causality is plausible from the code, not proven for every production error.

## Confirmed source-level gaps

1. `vercel.json` schedules `/api/recovery/transient` with Vercel Cron (`0 21 * * *`), which invokes GET. Before this patch the Next.js handler only exported POST. This mismatch blocks the built-in Vercel Cron route. The separate Upstash QStash schedule normally issues POST, and its health must be verified separately.
2. Merchant payment page links to `/receipts/<transaction UUID>`. The receipt API's legacy path required resolving that UUID through Redis history or Pi metadata to a canonical FlashPay ID and then a Redis projection. When that optional historical Redis evidence/index is unavailable, valid PostgreSQL transaction+receipt pairs returned 503 instead of a receipt. This code-level dependency is directly visible.

## Changed behavior (limited to read model + Cron request method)

- `app/api/recovery/transient/route.ts`: authorized GET wrapper for Vercel Cron. Requires constant-time verified `Authorization: Bearer <CRON_SECRET>` and delegates to the unchanged POST executor and its lease/financial guards. Unauthorized GET remains 403; absent CRON_SECRET fails closed. QStash POST authentication is intentionally unchanged.
- `app/api/receipts/[id]/route.ts`: if canonical FlashPay ID cannot be resolved for a stored transaction UUID, run a parameterized PostgreSQL read-only JOIN of transaction+receipt, constrained to the authenticated merchant and validated for merchant ID/UID, amount, optional customer/merchant amounts, zero commission, currency, and exact U2A linkage if present. Reject contradictions, null/invalid timestamps and duplicate rows. Never issue any write or create a receipt.
- `lib/legacy-receipt.ts`: pure historical-row verification. Returns a distinctly typed `postgres_transaction` read model with actual transaction UUID and receipt timestamp. No fabricated FlashPay ID, original creation time or blockchain finality certification.
- `app/receipts/[id]/page.tsx` and `lib/types.ts`: distinct printable historical receipt UI. Explicitly labels PostgreSQL transaction ID vs canonical FlashPay payment ID; describes stored settlement status and receipt event timestamp. Canonical receipt page and FlashPay PDF server uploads unchanged. Browser Print→Save as PDF remains possible; historical direct in-app PDF share/upload is intentionally not misrepresented.

## Evidence

- 21/21 PASS — isolated Node/TypeScript VM tests: historical row checks, merchant/UID/amount/commission/U2A contradictions, timestamps, fallback HTTP handler under mock database, unauthorized and foreign-owner denial, duplicate rejection, cron GET authentication/POST delegation, CRON_SECRET absence fail closed. No DB/Redis/Pi/Horizon requests.
- Modified TS/TSX transpilation syntax diagnostics 0/5.
- `node scripts/run-financial-recovery-build-verifier.mjs`: EXIT 0; financial predicates and source verifiers PASS (not proof of live behavior).
- Pre-patch production request logs on 2026-10-16 include authenticated GET `/api/receipts/<UUID>` with PostgreSQL query success, but returned HTTP status and displayed page could not be established from runtime log text alone.
- Upstash screenshot on 2026-10-15 shows QStash schedule Active and Last Run N/A. No confirmed QStash delivery/auth success was obtained. Its recurrence, forwarded secret, and last execution MUST be verified in Upstash. No QStash schedule settings were changed.

## Explicit proof gaps / release gates

- No full Next.js dependency installation or end-to-end production/preview build in this runtime (npm registry inaccessible); this ZIP is not a verified production executable.
- No authenticated live merchant click/receipt UI test on the patched build; no payment mutations executed.
- Vercel Cron requires CRON_SECRET configured. QStash must send POST and a correct forwarded `x-flashpay-transient-recovery-secret` header matching `FLASHPAY_TRANSIENT_RECOVERY_SECRET`, or another independently verified existing authorization contract. Do not publish those secrets in logs.
- QStash scheduling is external. A code patch cannot make an upstream scheduler dispatch if it has no actual last run. Check QStash logs and destination request status (403/405/503/timeout) after Preview deployment. Do NOT loosen financial endpoint authentication to make an external scheduler appear to work.
- Vercel `vercel.json` daily Cron cadence not altered. QStash 1-minute test / 10-minute normal cadence must be configured at QStash, not inferred from Next source.
- Historical transaction that truly has no PostgreSQL receipt must still return 404. 306 receipts/307 transactions was proven in R31 production snapshot; do not fabricate 307th receipt.
- R31 production read-only PostgreSQL was already accomplished on Oct 15: 106 checkpoints (48 db_finalized, 58 payment_identity), 307 transactions, 306 receipts; 48/48 finalized have matching transactions+receipts and recorded amounts/identity; 25 identity-stage checkpoints lack transaction by U2A join; one completed transaction lacks a receipt. Do NOT redo the connectivity handshake, schema discovery or those aggregate queries without evidence of changed data.
- FIN-100B remains OPEN and financial release NO-GO until live Preview request tests and explicit user decision. Reevaluate QStash dispatch, Vercel Cron secret and production logs without financial mutation before any Production deploy.
