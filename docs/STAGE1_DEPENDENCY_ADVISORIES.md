# Stage 1 dependency advisory record

Recorded 2026-09-21 after the Stage 1 local validation run.

## deepmerge-ts stack-exhaustion advisory

- Affected package: `deepmerge-ts@7.1.5`.
- Dependency path: `prisma@6.19.3` → `@prisma/config@6.19.3` → `deepmerge-ts@7.1.5`.
- Audit result: `npm audit --omit=dev --audit-level=high` reports three high-severity findings and proposes `npm audit fix --force`, which would install Prisma `6.12.0` as a breaking downgrade.
- Runtime classification: Prisma CLI/config tooling path. `@prisma/client` is the application runtime package; the vulnerable merge package is not imported by the application route code.
- Stage 1 reachability: no untrusted request data is passed to Prisma CLI/config loading in deployed request handlers. Prisma migration and generation commands run only in controlled build/release operations.
- Decision: do not apply the proposed breaking downgrade during Stage 1. A downgrade could invalidate the validated schema/client and migration toolchain without addressing the native request-path security model.
- Mitigation: keep Prisma CLI off runtime request paths, run the isolated migration gate, retain the existing lockfile, and block release if dependency analysis later shows the vulnerable package is shipped or reachable from production request processing.
- Owner: Dinodia Platform Engineering.
- Follow-up: evaluate a compatible Prisma upgrade or patched dependency override in a separate dependency change, rerun both Vercel/AWS builds, isolated migration validation and parity checks, and close this record before production release if the package becomes runtime-reachable.

This advisory is not a substitute for the release-candidate security review. It remains an open risk record and must not be reported as fixed by the Stage 1 build results.
