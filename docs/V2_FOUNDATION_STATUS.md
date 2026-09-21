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
- `dinodia-platform-aws` is being retired and is not a runtime dependency.

## Database rule

The standard schema-changing command must run through the V2 target guard. It must positively identify the new Supabase project before any migration. No old database data or migration history is imported.

## Current boundary

This foundation establishes repository/cloud/database isolation. It does not claim that Stage 1 security, native device transport, homeowner/tenant live data or Alexa behavior is complete.
