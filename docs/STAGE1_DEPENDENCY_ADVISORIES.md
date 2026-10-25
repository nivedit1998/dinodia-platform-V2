# Stage 1 dependency advisory record

Reviewed 2026-09-26 after the R11 dependency and release-gate runs.

## Current disposition

No high-severity findings were reported by the full or runtime-only audits in
the in-scope Node repositories:

| Repository | Full audit | Runtime-only audit | Owner | Next review |
|---|---|---|---|---|
| `dinodia-platform-V2` | `npm audit --audit-level=high`: 0 vulnerabilities | `npm audit --omit=dev --omit=optional --audit-level=high`: 0 vulnerabilities | Dinodia Platform Engineering | 2026-10-15 and before each candidate |
| `dinodia-edge-worker-V2` | `npm audit --audit-level=high`: 0 vulnerabilities | `npm audit --omit=dev --omit=optional --audit-level=high`: 0 vulnerabilities | Dinodia Edge Engineering | 2026-10-15 and before each candidate |
| `Dinodia OS` | `npm audit --audit-level=high`: 0 vulnerabilities | `npm audit --omit=dev --omit=optional --audit-level=high`: 0 vulnerabilities | Dinodia OS Engineering | 2026-10-15 and before each candidate |

The Platform dependency tree pins the compatible `deepmerge-ts@8.0.2` override
under Prisma 6.19.3; `npm ls deepmerge-ts --all` confirmed the selected version.
The Edge Wrangler/tooling graph also passed the complete audit after the
reviewed lockfile update. These results replace the historical open findings
below; do not continue to report them as unresolved advisories. Re-run both
audit modes after any dependency or lockfile change. Any new runtime-reachable
high/critical finding blocks release until fixed or explicitly re-evaluated.

No current tooling-only advisory requires a deferred-risk exception, owner
waiver or compensating-control record. If a later audit reports one, add the
exact package path, runtime reachability assessment, named owner, mitigation
and dated target here before proceeding.
