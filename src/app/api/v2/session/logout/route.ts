import { DELETE } from '../../auth/session/route';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return DELETE(request);
}
