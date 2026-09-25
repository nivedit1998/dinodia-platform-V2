# Stage 1 dependency advisory record

Recorded 2026-09-21 after the Native V2 foundation validation run. Updated
2026-09-22 after the final local Stage 1 remediation gates.

## deepmerge-ts stack-exhaustion advisory

- Affected package: `deepmerge-ts@7.1.5`.
- Dependency path: `prisma@6.19.3` → `@prisma/config@6.19.3` → `deepmerge-ts@7.1.5`.
- Audit result: `npm audit --omit=dev` reports three high-severity findings through the `devOptional` Prisma CLI/config chain. `npm audit --omit=dev --omit=optional --audit-level=high` reports zero findings for the runtime dependency set. The full `npm audit` additionally reports development-tool findings in `@babel/core`, `@humanfs/node`, `brace-expansion`, `browserslist` and `js-yaml`.
- Dependency path: `@prisma/client@6.19.0` has an optional peer on `prisma`; the installed `prisma@6.19.3` brings `@prisma/config@6.19.3` and `deepmerge-ts@7.1.5`. The vulnerable chain is marked `devOptional` in the lockfile and is required for generation/migration tooling, not the deployed Next.js request bundle.
- Runtime classification: Prisma CLI/config tooling path. `@prisma/client` is the application runtime package; the vulnerable merge package is not imported by the application route code. The runtime-only audit excluding optional tooling dependencies is clean.
- Stage 1 reachability: no untrusted request data is passed to Prisma CLI/config loading in deployed request handlers. Prisma migration and generation commands run only in controlled build/release operations. The clean-source proof also runs these commands against disposable PostgreSQL only.
- Decision: do not apply the proposed breaking downgrade during Stage 1. A downgrade could invalidate the validated schema/client and migration toolchain without addressing the native request-path security model.
- Mitigation: keep Prisma CLI off runtime request paths, run the isolated migration gate, retain the existing lockfile, run `npm audit --omit=dev --omit=optional --audit-level=high` as the runtime gate, and block release if dependency analysis later shows the vulnerable package is shipped or reachable from production request processing.
- Owner: Dinodia Platform Engineering.
- Follow-up target: 2026-10-15. Evaluate a compatible Prisma upgrade or patched dependency override in a separate dependency change, rerun the Vercel build, isolated migration validation and parity checks, and close this record before production release if the package becomes runtime-reachable. Do not use `npm audit fix --force`; the current resolver proposes a breaking Prisma downgrade rather than a safe patch.

This advisory is not a substitute for the release-candidate security review. It remains an open risk record and must not be reported as fixed by the Stage 1 build results.

## Edge Wrangler/miniflare development-tooling advisories

- Affected paths: `wrangler` development tooling and its `miniflare` dependency chain, including `esbuild`, `sharp`, `undici` and `ws` findings reported by `npm audit` on 2026-09-22.
- Runtime classification: development/deployment tooling only. The deployed Worker bundle contains the checked V2 Worker source and does not import the vulnerable local CLI dependency paths. The Worker package's `npm audit --omit=dev --omit=optional --audit-level=high` result is zero findings.
- Stage 1 reachability: these packages are used by local Wrangler tests/dry-runs and are not reachable from customer requests handled by the deployed Worker. No production schedule or runtime dependency is introduced by this toolchain.
- Decision: accept temporarily as a tooling-only risk for the current implementation cycle; do not force an unreviewed Wrangler/miniflare downgrade or rewrite the Worker deployment toolchain during Stage 1.
- Mitigation: run the Worker typecheck, behavioral fetch tests, explicit RC Wrangler dry-run, topology scan and runtime-only audit before each candidate. Do not run the development server against untrusted inputs or use the vulnerable CLI as a production request handler.
- Owner: Dinodia Edge/Platform Engineering.
- Follow-up target: 2026-10-15. Upgrade Wrangler to a release with patched transitive dependencies when compatible, then repeat the Worker tests and RC dry-run. This record must be closed or renewed with a dated decision before the next release gate.
