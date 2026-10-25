import { NextResponse } from 'next/server';
import { validateCustomerRoomQrScanReceipt, validateCustomerRoomQrScanRequest } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { sha256 } from '@/lib/stage1Crypto';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { previewCustomerRoomQr } from '@/lib/customerRoomAccess';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!validateCustomerRoomQrScanRequest(body)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Scan a current Dinodia Room QR');
    await enforcePersistentRateLimit(`room-qr-scan:${sha256(body.reference)}`, 30, 15 * 60 * 1000);
    const receipt = await previewCustomerRoomQr(body.reference);
    if (!validateCustomerRoomQrScanReceipt(receipt)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The Room QR preview failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
