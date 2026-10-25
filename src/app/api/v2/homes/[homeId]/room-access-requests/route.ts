import { GET as listRequests, POST as decideRequest } from '../area-access-requests/route';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  return listRequests(request, context);
}

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  return decideRequest(request, context);
}
