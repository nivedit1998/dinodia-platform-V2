# Native V2 Foundation Status

The V2 backend uses a fresh Vercel project and a fresh Supabase project. The old Vercel/Supabase resources are reference-only and must not be targeted by local scripts.

## Active resources

- Backend repository: `dinodia-platform-V2`
- Edge repository: `dinodia-edge-worker-V2`
- Alexa repository: `dinodia-alexa-skill-V2`
- Vercel project: `dinodia-platform-v2`
- Supabase project: `dinodia-native-v2`
- Supabase region: `eu-west-2`

## Non-active resources

- `dinodia-platform` is frozen reference source.
- `dinodia-edge-worker` is frozen reference source.
- `dinodia-alexa-skill` is frozen reference source.
- There is no `dinodia-platform-aws` backend in the Native V2 system. AWS is not a runtime dependency or fallback.

## Database rule

The standard schema-changing command must run through the V2 target guard. It must positively identify the new Supabase project before any migration. No old database data or migration history is imported.

## Current boundary

This foundation exposes only the status shell, `/api/health` and `/api/readiness`. It does not claim that Stage 1 security, native device transport, homeowner/tenant live data, support, automations, analytics or Alexa behavior is complete. Those features are added by numbered Native V2 plans against the schema authority map. The corrected foundation must pass the Docker, clean-source and Preview gates before it is safe to commit.
