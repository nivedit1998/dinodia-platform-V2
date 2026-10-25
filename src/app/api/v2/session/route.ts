import { GET as restore, POST as create, DELETE as end } from '../auth/session/route';

// Canonical contract path. The auth/session route remains as a Stage 1
// compatibility entry point; both paths execute the same handlers.
export const dynamic = 'force-dynamic';
export const GET = restore;
export const POST = create;
export const DELETE = end;
