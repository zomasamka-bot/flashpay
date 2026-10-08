# FIN-17 — Release Hygiene — Final Evidence
Date: 2026-10-08
Baseline production SHA before FIN-17 packaging: bad00ab785f17a361839f876537b9488f7057790

## Scope
Release hygiene and final regression certification only. No financial runtime, UI, dependency, schema, wallet, secret, Pi, Horizon, Redis, or PostgreSQL behavior is changed by FIN-17.

## Proven pre-packaging predicates
- Uploaded FIN-15 baseline SHA-256: `f1826c14ecd1c19363a656d48e472a910168cfacd73e7facb73d4bf55169a1bd`.
- ZIP integrity test: PASS.
- Forbidden release paths/files absent: `.git`, `.vercel`, `node_modules`, `.next`, `.env*`, `.DS_Store`, private-key/certificate/backup/temp/log artifacts.
- Source manifest set equality: complete, no stale entries, all listed hashes verified.
- High-risk literal secret scan: zero findings for private-key blocks, embedded PostgreSQL/Redis URLs, GitHub PAT pattern, and live-secret pattern.
- Byte Studio dependency contract remains pinned: cmdk 1.1.1; embla-carousel-react 8.5.2; input-otp 1.4.2; react-day-picker 9.7.0; react-resizable-panels 2.1.8; recharts 2.15.0; vaul 0.9.9.
- Mandatory financial verifier remains the build precondition before `next build`.
- Full mandatory financial verifier executed on the clean source and returned exit code 0, including financial invariants, finality, crash policy, Settlement XOR Refund, wallet submit boundary, Redis projection/CAS, production callgraph binding, DR11, FIN-5, FIN-6, FIN-7, FIN-8, FIN-11, FIN-12, FIN-13, FIN-14, and FIN-15.

## Important boundary
FIN-16 Byte Studio Round-Trip remains a separate proof gate. FIN-17 hygiene does not fabricate or substitute for the missing real Byte Studio export comparison. Release hygiene can be certified independently, but final FIN-1→FIN-17 program closure still requires FIN-16 to close.

## Runtime impact
- Runtime financial kernel changed: NO
- UI changed: NO
- Dependencies/lock changed: NO
- Schema changed: NO
- Mainnet enabled: NO
- Commission enabled: NO

## Closure rule
This artifact is PRE-PRODUCTION certified. FIN-17 becomes formally CLOSED only after publishing this exact clean package and proving Git SHA ↔ Vercel production deployment ↔ mandatory build output correspondence with `FIN17_RELEASE_HYGIENE=PASS`.

## Vercel/Pi Studio workspace correction — 2026-10-08
The first FIN-17 production build exposed a verifier-only defect: the hygiene verifier treated
Vercel-generated `.git`, `node_modules`, `.next`, `.vercel`, and package-manager store content as
if those ephemeral workspace paths had been shipped inside the clean release artifact.
The application and all FIN-1→FIN-15 financial certifiers passed before this verifier stopped the build.

Correction: FIN-17 now validates the immutable release-source set represented by
`certification/SOURCE_MANIFEST.sha256` while excluding only known ephemeral workspace directories
`.git`, `.vercel`, `node_modules`, `.next`, and `.pnpm-store` from the post-install workspace walk.
The clean ZIP itself is independently inspected and MUST contain none of those directories.
No application/runtime/schema/dependency/lockfile/financial-kernel file was changed by this correction.

## Final verifier boundary correction — Vercel evidence
A second production build proved that Vercel may add `.gitignore` and transform `pnpm-lock.yaml`
and `vercel.json` before the project build command. Therefore post-install workspace equality cannot
serve as a clean-artifact hash attestation.

Final split:
1. Clean artifact certification (pre-publish): exact manifest/hash equality, forbidden artifact scan,
   secret scan, ZIP integrity, dependency pins.
2. Vercel/Pi Studio build-safety gate: well-formed manifest attestation present, dependency pins,
   secret scan over release source, mandatory financial verifier wiring, FIN-15 gate wiring.
3. All financial/runtime certifiers remain mandatory before `next build`.

This is a verifier-boundary correction only. No app/lib/components/schema/package/lock/runtime
financial source was changed.
