import { POST as issueManagerInvitation } from '../route';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  return issueManagerInvitation(request, context);
}
